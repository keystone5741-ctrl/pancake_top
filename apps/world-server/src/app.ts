import { randomUUID } from "node:crypto";
import { decodeTower } from "pancake-physics";
import { encodeCountry } from "pancake-core";
import type { ServerConfig } from "./config";
import type { Db } from "./db/db";
import { acceptsPurchases, assertTransition, type DropStatus } from "./drops/coordinator";
import { DropScheduler, type DropSlot } from "./drops/scheduler";
import { SimulationWorkerClient, WorkerCrashError } from "./sim/workerClient";
import type { ChunkStorage } from "./world/chunkStorage";
import { WorldEvents, type DropSummary } from "./world/events";
import { allocateSerials, ensureWorld, normalizeCountry } from "./world/serial";
import { WorldStore } from "./world/worldStore";

export interface DropRow { drop_id: string; scheduled_at: Date; cutoff_at: Date; status: DropStatus; start_serial: number | null; end_serial: number | null; pancake_count: number; height_before: number | null; height_after: number | null; simulation_started_at: Date | null; simulation_finished_at: Date | null; released_at: Date | null }

export interface AppOptions { db: Db; storage: ChunkStorage; config: ServerConfig; clock?: () => Date; worker?: SimulationWorkerClient }

/**
 * Application layer (Phase 2 §4): HTTP/WS → 여기 → DropCoordinator 규칙 → worker → WorldStore → DB/storage.
 * Rapier 는 worker 프로세스에만 있다.
 */
export class WorldApp {
  readonly db: Db;
  readonly cfg: ServerConfig;
  readonly store: WorldStore;
  readonly events = new WorldEvents();
  readonly scheduler: DropScheduler;
  readonly worker: SimulationWorkerClient;
  readonly clock: () => Date;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private loopPromise: Promise<void> | null = null;
  private stopped = false;
  private queueTimer: NodeJS.Timeout | null = null;
  private queueDirty = false;
  private delayedNotified = new Set<string>();
  private lastSnapshotSerial = 0;
  private workerSpawnedSinceInit = 0;
  readonly metrics = {
    purchaseEvents: [] as number[],
    simJobsMs: [] as number[],
    simPancakes: [] as { t: number; n: number }[],
    workerCrashes: 0,
    jobRetries: 0,
    jobsFailed: 0,
    dropFinalizeMs: [] as number[],
    wsClients: 0,
    lastJobMetrics: null as Record<string, unknown> | null,
  };

  constructor(opts: AppOptions) {
    this.db = opts.db; this.cfg = opts.config;
    this.clock = opts.clock ?? (() => new Date());
    this.scheduler = new DropScheduler(this.cfg.dropIntervalSeconds, this.cfg.dropCutoffSeconds);
    this.store = new WorldStore(this.db, opts.storage, this.cfg);
    this.worker = opts.worker ?? new SimulationWorkerClient({ config: { batchSize: Math.min(500, Math.max(1, this.cfg.simBatchSize)) }, capacity: 200_000, surfaceTopN: this.cfg.surfaceTopN, surfaceSliceSize: this.cfg.surfaceSliceSize, onCrash: () => { this.metrics.workerCrashes++; } });
  }

  // ---------------------------------------------------------------- lifecycle
  async start(): Promise<void> {
    await this.db.migrate();
    await ensureWorld(this.db, this.cfg.worldId);
    await this.store.load();
    await this.store.recoverJobs();
    await this.ensureCurrentDrop();
    this.stopped = false;
    this.timer = setInterval(() => { void this.tick(); }, 1000);
    this.kick();
  }
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.queueTimer) clearTimeout(this.queueTimer);
    await this.loopPromise;
    await this.worker.stop();
  }

  // ---------------------------------------------------------------- drops
  async getDrop(dropId: string): Promise<DropRow | null> {
    return (await this.db.query<DropRow>("SELECT * FROM drops WHERE drop_id = $1", [dropId])).rows[0] ?? null;
  }
  /** 지금 구매가 들어갈 Drop 행을 보장한다 */
  async ensureCurrentDrop(): Promise<DropRow> {
    const slot = this.scheduler.currentDrop(this.clock());
    return this.ensureDropRow(slot);
  }
  private async ensureDropRow(slot: DropSlot): Promise<DropRow> {
    await this.db.query("INSERT INTO drops (drop_id, scheduled_at, cutoff_at, status, height_before) VALUES ($1, $2, $3, 'OPEN', $4) ON CONFLICT (drop_id) DO NOTHING", [slot.dropId, slot.scheduledAt, slot.cutoffAt, this.store.worldState.height_meters]);
    await this.db.query("UPDATE world_state SET current_drop_id = $2 WHERE world_id = $1 AND (current_drop_id IS NULL OR current_drop_id < $2)", [this.cfg.worldId, slot.dropId]);
    return (await this.getDrop(slot.dropId))!;
  }
  async currentDrop(): Promise<DropRow> {
    const ws = (await this.db.query<{ current_drop_id: string | null }>("SELECT current_drop_id FROM world_state WHERE world_id = $1", [this.cfg.worldId])).rows[0];
    const d = ws.current_drop_id ? await this.getDrop(ws.current_drop_id) : null;
    return d ?? this.ensureCurrentDrop();
  }
  private async transition(dropId: string, to: DropStatus, extra: Record<string, unknown> = {}): Promise<DropRow> {
    const d = await this.getDrop(dropId);
    if (!d) throw new Error(`unknown drop ${dropId}`);
    assertTransition(dropId, d.status, to);
    const sets = ["status = $2", ...Object.keys(extra).map((k, i) => `${k} = $${i + 3}`)];
    await this.db.query(`UPDATE drops SET ${sets.join(", ")} WHERE drop_id = $1`, [dropId, to, ...Object.values(extra)]);
    return (await this.getDrop(dropId))!;
  }

  /** 초당 tick: cutoff → CLOSING, 완료 → READY, 시각 도래 → RELEASED / DELAYED */
  async tick(now = this.clock()): Promise<void> {
    if (this.stopped) return;
    const drops = (await this.db.query<DropRow>("SELECT * FROM drops WHERE status NOT IN ('RELEASED','FAILED') ORDER BY scheduled_at")).rows;
    for (const d of drops) {
      let cur = d;
      if (acceptsPurchases(cur.status) && now.getTime() >= cur.cutoff_at.getTime()) {
        cur = await this.transition(cur.drop_id, "CLOSING");
        const next = await this.ensureDropRow(this.scheduler.after(this.scheduler.slotFor(cur.scheduled_at)));
        this.events.emitEvent({ type: "drop.closing", dropId: cur.drop_id, scheduledAt: cur.scheduled_at.toISOString(), nextDropId: next.drop_id });
        this.kick();
      }
      if (cur.status === "CLOSING" || cur.status === "FINALIZING") {
        const pending = await this.pendingForDrop(cur.drop_id);
        if (pending === 0) {
          const finMs = cur.cutoff_at ? now.getTime() - cur.cutoff_at.getTime() : 0;
          cur = await this.transition(cur.drop_id, "READY", { simulation_finished_at: now });
          this.metrics.dropFinalizeMs.push(finMs);
          await this.store.snapshot(); // §35: Drop 완료 시 반드시 snapshot
          this.events.emitEvent({ type: "drop.ready", dropId: cur.drop_id, scheduledAt: cur.scheduled_at.toISOString(), pancakeCount: cur.pancake_count, heightAfter: cur.height_after ?? this.store.worldState.height_meters });
        } else if (cur.status === "CLOSING") cur = await this.transition(cur.drop_id, "FINALIZING");
      }
      if (now.getTime() >= cur.scheduled_at.getTime()) {
        if (cur.status === "READY") {
          cur = await this.transition(cur.drop_id, "RELEASED", { released_at: now });
          this.events.emitEvent({ type: "drop.released", dropId: cur.drop_id, startSerial: cur.start_serial, endSerial: cur.end_serial, pancakeCount: cur.pancake_count, heightBefore: cur.height_before, heightAfter: cur.height_after, version: this.store.version });
          this.delayedNotified.delete(cur.drop_id);
        } else if (!this.delayedNotified.has(cur.drop_id) && cur.status !== "OPEN") {
          this.delayedNotified.add(cur.drop_id);
          this.events.emitEvent({ type: "drop.delayed", dropId: cur.drop_id, scheduledAt: cur.scheduled_at.toISOString(), status: cur.status, pending: await this.pendingForDrop(cur.drop_id) });
        }
      }
    }
    await this.ensureCurrentDrop();
  }

  private async pendingForDrop(dropId: string): Promise<number> {
    return (await this.db.query<{ n: number }>("SELECT COUNT(*)::int AS n FROM pancakes WHERE drop_id = $1 AND committed_at IS NULL", [dropId])).rows[0].n;
  }

  // ---------------------------------------------------------------- purchases (§7, §8)
  async purchase(req: { quantity: number; country?: string; idempotencyKey?: string | null }): Promise<{ orderId: string; dropId: string; startSerial: number; endSerial: number; countryStartSerial: number; countryEndSerial: number; replayed: boolean; scheduledAt: string }> {
    const now = this.clock();
    const slot = this.scheduler.currentDrop(now);
    let drop = await this.getDrop(slot.dropId);
    if (!drop) drop = await this.ensureDropRow(slot);
    if (!acceptsPurchases(drop.status)) { // 이미 닫힌 경우 다음 Drop
      const next = await this.ensureDropRow(this.scheduler.after(slot));
      drop = next;
    }
    const a = await allocateSerials(this.db, this.cfg.worldId, { quantity: req.quantity, country: normalizeCountry(req.country), dropId: drop.drop_id, idempotencyKey: req.idempotencyKey ?? null, chunkSize: this.cfg.chunkSize });
    this.metrics.purchaseEvents.push(Date.now());
    if (this.metrics.purchaseEvents.length > 5000) this.metrics.purchaseEvents.splice(0, this.metrics.purchaseEvents.length - 5000);
    this.markQueueDirty(drop.drop_id);
    this.kick();
    return { ...a, scheduledAt: drop.scheduled_at.toISOString() };
  }

  /** queueUpdated 는 throttle (§32) */
  private markQueueDirty(dropId: string): void {
    this.queueDirty = true;
    if (this.queueTimer) return;
    this.queueTimer = setTimeout(async () => {
      this.queueTimer = null;
      if (!this.queueDirty) return;
      this.queueDirty = false;
      const d = await this.getDrop(dropId);
      if (d) this.events.emitEvent({ type: "drop.queueUpdated", dropId: d.drop_id, queueSize: d.pancake_count, scheduledAt: d.scheduled_at.toISOString() });
    }, this.cfg.queueThrottleMs);
  }

  // ---------------------------------------------------------------- continuous simulation (§26)
  /** 파이프라인을 깨운다. 이미 돌고 있으면 그대로. */
  kick(): void {
    if (this.running || this.stopped) return;
    this.running = true;
    this.loopPromise = this.loop().catch((e) => { console.error("[pipeline]", e); }).finally(() => { this.running = false; });
  }

  get pendingPancakes(): number { return this.store.worldState.latest_global_serial - this.store.worldState.committed_serial; }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      const ws = (await this.db.query<{ latest_global_serial: number; committed_serial: number }>("SELECT latest_global_serial, committed_serial FROM world_state WHERE world_id = $1", [this.cfg.worldId])).rows[0];
      const pending = ws.latest_global_serial - ws.committed_serial;
      if (pending <= 0) return;
      // batching window: 작은 구매가 흩어져 들어오면 잠깐 모은다
      if (pending < this.cfg.simBatchSize && this.cfg.simBatchWindowMs > 0) await new Promise((r) => setTimeout(r, this.cfg.simBatchWindowMs));
      const ws2 = (await this.db.query<{ latest_global_serial: number; committed_serial: number }>("SELECT latest_global_serial, committed_serial FROM world_state WHERE world_id = $1", [this.cfg.worldId])).rows[0];
      const start = ws2.committed_serial + 1;
      const end = Math.min(ws2.latest_global_serial, start + this.cfg.simBatchSize - 1);
      if (end < start) return;
      await this.runJob(start, end);
    }
  }

  private async runJob(start: number, end: number): Promise<void> {
    const rows = (await this.db.query<{ global_serial: number; country: string; drop_id: string }>("SELECT global_serial, country, drop_id FROM pancakes WHERE global_serial BETWEEN $1 AND $2 ORDER BY global_serial", [start, end])).rows;
    if (rows.length !== end - start + 1) throw new Error(`pancake rows missing for ${start}..${end}`);
    // job 은 drop 경계를 넘지 않는다 (drop 별 완료 판정을 단순하게)
    const dropId = rows[0].drop_id;
    let cut = rows.findIndex((r) => r.drop_id !== dropId);
    if (cut > 0) { end = start + cut - 1; rows.length = cut; }
    const countries = new Uint16Array(rows.map((r) => encodeCountry(r.country)));
    const d = await this.getDrop(dropId);
    if (d && d.status === "OPEN") await this.transition(dropId, "SIMULATING", { simulation_started_at: this.clock() });
    // job 행 (재시도 시 같은 input_snapshot 으로 다시 INIT)
    const existing = (await this.db.query<{ job_id: string; attempt: number; input_snapshot: Buffer | null; seed: number; status: string }>("SELECT job_id, attempt, input_snapshot, seed, status FROM simulation_jobs WHERE start_serial = $1 AND end_serial = $2 AND status IN ('PENDING','RETRYABLE','RUNNING') ORDER BY created_at DESC LIMIT 1", [start, end])).rows[0];
    let jobId: string, attempt: number, snapshot: Uint8Array | null, seed: number;
    if (existing) {
      jobId = existing.job_id; attempt = existing.attempt + 1; snapshot = existing.input_snapshot ? new Uint8Array(existing.input_snapshot) : null; seed = existing.seed;
      if (attempt > this.cfg.workerMaxAttempts) {
        await this.db.query("UPDATE simulation_jobs SET status = 'FAILED', finished_at = now(), error = COALESCE(error, 'max attempts') WHERE job_id = $1", [jobId]);
        this.metrics.jobsFailed++;
        await this.transition(dropId, "FAILED").catch(() => undefined);
        this.events.emitEvent({ type: "drop.failed", dropId, error: `job ${jobId} failed after ${existing.attempt} attempts` });
        this.stopped = true; // 무한 retry 금지: 운영자 개입 전까지 파이프라인 정지
        return;
      }
      await this.db.query("UPDATE simulation_jobs SET status = 'RUNNING', attempt = $2, started_at = now() WHERE job_id = $1", [jobId, attempt]);
    } else {
      jobId = `job_${randomUUID()}`; attempt = 1; seed = ((start * 2654435761) >>> 0) % 2147483647;
      snapshot = await this.store.surfaceSlice();
      await this.db.query("INSERT INTO simulation_jobs (job_id, drop_id, start_serial, end_serial, status, attempt, seed, input_snapshot, started_at) VALUES ($1,$2,$3,$4,'RUNNING',1,$5,$6, now())", [jobId, dropId, start, end, seed, snapshot ? Buffer.from(snapshot) : null]);
    }
    const t0 = performance.now();
    try {
      // worker 가 죽었거나 없으면 이 job 의 input snapshot 으로 INIT (마지막 안전 상태), 아니면 이어서 쌓는다
      if (!this.worker.ready || this.workerSpawnedSinceInit > 150_000 || attempt > 1) { await this.worker.reinit(snapshot); this.workerSpawnedSinceInit = 0; }
      const r = await this.worker.simulate(jobId, end - start + 1, seed);
      this.workerSpawnedSinceInit += end - start + 1;
      const final = decodeTower(r.finalTransforms.buffer.slice(r.finalTransforms.byteOffset, r.finalTransforms.byteOffset + r.finalTransforms.byteLength) as ArrayBuffer);
      final.startSerial = start;
      const { version, chunkIds } = await this.store.commit({ jobId, dropId, startSerial: start, endSerial: end, finalTransforms: final, heightUnits: r.heightUnits, countries });
      this.metrics.simJobsMs.push(performance.now() - t0); if (this.metrics.simJobsMs.length > 1000) this.metrics.simJobsMs.shift();
      this.metrics.simPancakes.push({ t: Date.now(), n: end - start + 1 }); if (this.metrics.simPancakes.length > 5000) this.metrics.simPancakes.shift();
      this.metrics.lastJobMetrics = { ...r.metrics, jobId, start, end, chunkIds };
      this.events.emitEvent({ type: "world.updated", version, committedPancakes: end, heightMeters: this.store.worldState.height_meters, latestChunkId: chunkIds[chunkIds.length - 1] });
      if (end - this.lastSnapshotSerial >= this.cfg.snapshotEveryPancakes) { await this.store.snapshot(); this.lastSnapshotSerial = end; }
    } catch (e) {
      const msg = e instanceof WorkerCrashError ? `worker crash: ${e.message}` : String(e);
      this.metrics.jobRetries++;
      await this.db.query("UPDATE simulation_jobs SET status = 'RETRYABLE', error = $2 WHERE job_id = $1", [jobId, msg]);
      // 파일이 먼저 써졌을 수 있다(커밋 전 실패): DB 가 authoritative 이므로 파일을 DB 로 되돌린다
      await this.store.refresh();
      if (!(e instanceof WorkerCrashError)) console.error("[job]", jobId, msg);
    }
  }

  // ---------------------------------------------------------------- read models
  async snapshotEvent(): Promise<Extract<import("./world/events").WorldEvent, { type: "world.snapshot" }>> {
    const d = await this.currentDrop();
    const ws = this.store.worldState;
    const summary: DropSummary = { dropId: d.drop_id, status: d.status, scheduledAt: d.scheduled_at.toISOString(), cutoffAt: d.cutoff_at.toISOString(), pancakeCount: d.pancake_count, queueSize: d.pancake_count };
    return { type: "world.snapshot", version: ws.version, totalPancakes: ws.latest_global_serial, committedPancakes: ws.committed_serial, heightMeters: ws.height_meters, currentDrop: summary, nextDropAt: d.scheduled_at.toISOString(), serverTime: this.clock().toISOString() };
  }

  async pancake(serial: number): Promise<Record<string, unknown> | null> {
    const p = (await this.db.query<{ global_serial: number; country: string; country_serial: number; drop_id: string; chunk_id: number; instance_index: number; variant: number; committed_at: Date | null }>("SELECT global_serial, country, country_serial, drop_id, chunk_id, instance_index, variant, committed_at FROM pancakes WHERE global_serial = $1", [serial])).rows[0];
    if (!p) return null;
    let height: number | null = null;
    if (p.committed_at) {
      const c = await this.store.chunkBytes(p.chunk_id);
      if (c) { const { decodeChunk } = await import("tower-engine"); const ch = decodeChunk(c.data.buffer.slice(c.data.byteOffset, c.data.byteOffset + c.data.byteLength) as ArrayBuffer).chunk; const y = ch.transforms[p.instance_index * 9 + 1]; height = (y * this.store.towerConfig.unitCm) / 100; }
    }
    return { globalSerial: p.global_serial, country: p.country, countrySerial: p.country_serial, dropId: p.drop_id, chunkId: p.chunk_id, instanceIndex: p.instance_index, variant: p.variant, committed: !!p.committed_at, height };
  }

  metricsSnapshot(): Record<string, unknown> {
    const now = Date.now();
    const per = (arr: number[], p: number): number => { if (!arr.length) return 0; const s = [...arr].sort((a, b) => a - b); return s[Math.floor((s.length - 1) * p)]; };
    const recent = this.metrics.simPancakes.filter((x) => now - x.t < 60_000).reduce((a, x) => a + x.n, 0);
    return {
      purchaseEventsPerSec: this.metrics.purchaseEvents.filter((t) => now - t < 10_000).length / 10,
      pendingSimulationPancakes: this.pendingPancakes,
      simulationThroughputPerSec: recent / 60,
      simulationJobP50Ms: per(this.metrics.simJobsMs, 0.5), simulationJobP95Ms: per(this.metrics.simJobsMs, 0.95),
      workerCrashes: this.metrics.workerCrashes, workerRestarts: this.worker.restarts, jobRetries: this.metrics.jobRetries, jobsFailed: this.metrics.jobsFailed,
      dropFinalizeMsP50: per(this.metrics.dropFinalizeMs, 0.5), dropFinalizeMsMax: per(this.metrics.dropFinalizeMs, 1),
      chunkWriteMsAvg: this.store.metrics.chunkWrites ? this.store.metrics.chunkWriteMs / this.store.metrics.chunkWrites : 0, chunkWrites: this.store.metrics.chunkWrites,
      commitMsAvg: this.store.metrics.commits ? this.store.metrics.commitMs / this.store.metrics.commits : 0, commits: this.store.metrics.commits,
      manifestMs: this.store.metrics.manifestMs, snapshots: this.store.metrics.snapshots, recoveredFiles: this.store.metrics.recoveredFiles,
      websocketClients: this.metrics.wsClients, worldVersion: this.store.version, pipelineRunning: this.running, pipelineStopped: this.stopped,
      lastJob: this.metrics.lastJobMetrics,
    };
  }
}
