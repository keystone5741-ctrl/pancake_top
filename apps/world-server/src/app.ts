import { randomUUID } from "node:crypto";
import { decodeTower } from "pancake-physics";
import { encodeCountry } from "pancake-core";
import { LeaderElector } from "./cluster/leader";
import type { ServerConfig } from "./config";
import type { Db } from "./db/db";
import { acceptsPurchases, assertTransition, type DropStatus } from "./drops/coordinator";
import { DropScheduler, type DropSlot } from "./drops/scheduler";
import { log } from "./log";
import { SimulationWorkerClient, WorkerCrashError, type ResultMsg } from "./sim/workerClient";
import type { ChunkStorage } from "./world/chunkStorage";
import { EventLog } from "./world/eventLog";
import { WorldEvents, type DropSummary, type WorldEvent } from "./world/events";
import { allocateSerials, ensureWorld, normalizeCountry } from "./world/serial";
import { CommitError, WorldStore, type FailureReason } from "./world/worldStore";

export interface DropRow { drop_id: string; scheduled_at: Date; cutoff_at: Date; status: DropStatus; start_serial: number | null; end_serial: number | null; pancake_count: number; height_before: number | null; height_after: number | null; simulation_started_at: Date | null; simulation_finished_at: Date | null; released_at: Date | null; failure_reason: string | null; failure_error: string | null; aborted_at: Date | null }
export interface JobRow { job_id: string; drop_id: string; start_serial: number; end_serial: number; status: string; attempt: number; seed: number; input_snapshot: Buffer | null; owner: string | null; lease_expires_at: Date | null; failure_reason: string | null; error: string | null; manual_retries: number }

export interface AppOptions { db: Db; storage: ChunkStorage; config: ServerConfig; clock?: () => Date; worker?: SimulationWorkerClient; /** false 면 leader 선출 없이 단독 leader (테스트/벤치) */ cluster?: boolean }

/**
 * Application layer (Phase 2 §4, Phase 3A). HTTP/WS → 여기 → DropCoordinator 규칙 → worker → WorldStore → DB/storage.
 * 여러 인스턴스가 같은 DB 를 쓸 수 있다: 구매/조회/WS 는 모두가, scheduler·coordinator·simulation 은 leader 만 (§22).
 * 이벤트는 world_events 에 기록되고 (§17) 모든 인스턴스가 LISTEN 으로 받아 자기 WS 클라이언트에 보낸다.
 */
export class WorldApp {
  readonly db: Db;
  readonly cfg: ServerConfig;
  readonly store: WorldStore;
  readonly events = new WorldEvents();
  readonly eventLog: EventLog;
  readonly leader: LeaderElector;
  readonly scheduler: DropScheduler;
  readonly worker: SimulationWorkerClient;
  readonly clock: () => Date;
  readonly instanceId: string;
  private readonly cluster: boolean;
  private timer: NodeJS.Timeout | null = null;
  private pruneTimer: NodeJS.Timeout | null = null;
  private running = false;
  private loopPromise: Promise<void> | null = null;
  private stopped = false;
  /** FAILED 뒤 운영자 개입 전까지 시뮬레이션 정지 (§25) */
  private halted = false;
  private isLeader = false;
  private queueTimer: NodeJS.Timeout | null = null;
  private queueDirty = false;
  private delayedNotified = new Set<string>();
  private lastSnapshotSerial = 0;
  private workerSpawnedSinceInit = 0;
  /** pipeline overlap: 직전 job 의 커밋 (물리 lane 과 겹쳐 돈다) */
  private inflight: { jobId: string; end: number; surfaceAfter: Uint8Array; promise: Promise<boolean> } | null = null;
  readonly metrics = {
    purchaseEvents: [] as number[],
    simJobsMs: [] as number[],
    simPancakes: [] as { t: number; n: number }[],
    workerCrashes: 0,
    jobRetries: 0,
    jobsFailed: 0,
    recoveries: 0,
    dropFinalizeMs: [] as number[],
    wsClients: 0,
    lastJobMetrics: null as Record<string, unknown> | null,
    overlappedCommits: 0,
    discardedResults: 0,
    claimConflicts: 0,
  };

  constructor(opts: AppOptions) {
    this.db = opts.db; this.cfg = opts.config;
    this.clock = opts.clock ?? (() => new Date());
    this.instanceId = this.cfg.instanceId;
    this.cluster = opts.cluster ?? true;
    this.scheduler = new DropScheduler(this.cfg.dropIntervalSeconds, this.cfg.dropCutoffSeconds);
    this.store = new WorldStore(this.db, opts.storage, this.cfg);
    this.eventLog = new EventLog(this.db, { worldId: this.cfg.worldId, instanceId: this.instanceId, retentionHours: this.cfg.eventRetentionHours, retentionCount: this.cfg.eventRetentionCount, auditTypes: this.cfg.eventAuditTypes });
    this.eventLog.onEvent((se) => { this.events.emitEvent({ ...(se.payload as object), eventId: se.eventId } as WorldEvent); });
    this.leader = new LeaderElector(this.db, this.cfg.worldId, this.instanceId, this.cfg.leaderLeaseMs, (is) => this.onLeaderChange(is).catch((e) => log.error("leader.change_failed", { error: String(e) })));
    this.worker = opts.worker ?? new SimulationWorkerClient({ config: { batchSize: Math.min(500, Math.max(1, this.cfg.simBatchSize)) }, capacity: 200_000, surfaceTopN: this.cfg.surfaceTopN, surfaceSliceSize: this.cfg.surfaceSliceSize, onCrash: () => { this.metrics.workerCrashes++; } });
  }

  get leaderNow(): boolean { return this.isLeader; }
  get pipelineHalted(): boolean { return this.halted; }

  // ---------------------------------------------------------------- lifecycle
  async start(): Promise<void> {
    await this.db.migrate();
    await ensureWorld(this.db, this.cfg.worldId);
    await this.store.load();
    await this.eventLog.startListening();
    this.stopped = false;
    if (this.cluster) await this.leader.start();
    else await this.onLeaderChange(true);
  }
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    if (this.queueTimer) clearTimeout(this.queueTimer);
    await this.loopPromise;
    await this.inflight?.promise;
    if (this.cluster) await this.leader.stop(); else if (this.isLeader) { this.isLeader = false; }
    await this.eventLog.stopListening();
    await this.worker.stop();
    await this.store.close();
  }

  /** leader 획득/상실 (§22~§23). leader 만 tick·파이프라인·retention 을 돈다. */
  private async onLeaderChange(isLeader: boolean): Promise<void> {
    if (isLeader === this.isLeader) return;
    this.isLeader = isLeader;
    log.info("leader.changed", { instanceId: this.instanceId, isLeader, term: this.leader.term });
    if (isLeader) {
      await this.store.refresh();
      const reclaimed = await this.store.recoverJobs();
      if (reclaimed) log.warn("jobs.reclaimed", { count: reclaimed });
      await this.ensureCurrentDrop();
      this.timer = setInterval(() => { this.tick().catch((e) => log.error("tick.failed", { error: String(e) })); }, 1000);
      this.pruneTimer = setInterval(() => { void this.eventLog.prune().catch((e) => log.error("events.prune", { error: String(e) })); }, 60_000);
      await this.publish({ type: "leader.changed", instanceId: this.instanceId, isLeader: true, term: this.leader.term });
      this.kick();
    } else {
      if (this.timer) clearInterval(this.timer); this.timer = null;
      if (this.pruneTimer) clearInterval(this.pruneTimer); this.pruneTimer = null;
      // 돌던 loop 는 다음 반복에서 leader 가 아님을 보고 멈춘다. in-flight 커밋은 version 검사로 보호된다.
    }
  }

  /** 이벤트 기록 + 전파 (§17). world_version 은 현재 store version. */
  async publish(e: WorldEvent): Promise<void> {
    try { await this.eventLog.append(e, this.store.version); }
    catch (err) { log.error("events.append", { error: String(err), eventType: e.type }); this.events.emitEvent(e); }
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
    const ins = await this.db.query("INSERT INTO drops (drop_id, scheduled_at, cutoff_at, status, height_before) VALUES ($1, $2, $3, 'OPEN', $4) ON CONFLICT (drop_id) DO NOTHING", [slot.dropId, slot.scheduledAt, slot.cutoffAt, this.store.worldState.height_meters]);
    await this.db.query("UPDATE world_state SET current_drop_id = $2 WHERE world_id = $1 AND (current_drop_id IS NULL OR current_drop_id < $2)", [this.cfg.worldId, slot.dropId]);
    if (ins.rowCount) await this.publish({ type: "drop.opened", dropId: slot.dropId, scheduledAt: slot.scheduledAt.toISOString(), cutoffAt: slot.cutoffAt.toISOString() });
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
    log.info("drop.transition", { dropId, from: d.status, to });
    return (await this.getDrop(dropId))!;
  }

  /** tick 은 재진입하지 않는다 (타이머 tick 과 수동/테스트 tick 이 겹치면 같은 전이를 두 번 시도한다) */
  private tickChain: Promise<void> = Promise.resolve();
  tick(now = this.clock()): Promise<void> { const run = this.tickChain.then(() => this.tickOnce(now)); this.tickChain = run.catch(() => undefined); return run; }
  /** 초당 tick (leader 만): cutoff → CLOSING, 완료 → READY, 시각 도래 → RELEASED / DELAYED */
  private async tickOnce(now: Date): Promise<void> {
    if (this.stopped || !this.isLeader) return;
    const drops = (await this.db.query<DropRow>("SELECT * FROM drops WHERE status NOT IN ('RELEASED','FAILED') ORDER BY scheduled_at")).rows;
    for (const d of drops) {
      let cur = d;
      if (acceptsPurchases(cur.status) && now.getTime() >= cur.cutoff_at.getTime()) {
        cur = await this.transition(cur.drop_id, "CLOSING");
        const next = await this.ensureDropRow(this.scheduler.after(this.scheduler.slotFor(cur.scheduled_at)));
        await this.publish({ type: "drop.closing", dropId: cur.drop_id, scheduledAt: cur.scheduled_at.toISOString(), nextDropId: next.drop_id });
        this.kick();
      }
      if (cur.status === "CLOSING" || cur.status === "FINALIZING") {
        const pending = await this.pendingForDrop(cur.drop_id);
        if (pending === 0) {
          const finMs = cur.cutoff_at ? now.getTime() - cur.cutoff_at.getTime() : 0;
          cur = await this.transition(cur.drop_id, "READY", { simulation_finished_at: now });
          this.metrics.dropFinalizeMs.push(finMs);
          await this.store.snapshot(); // §35: Drop 완료 시 반드시 snapshot
          await this.publish({ type: "drop.ready", dropId: cur.drop_id, scheduledAt: cur.scheduled_at.toISOString(), pancakeCount: cur.pancake_count, heightAfter: cur.height_after ?? this.store.worldState.height_meters });
        } else if (cur.status === "CLOSING") cur = await this.transition(cur.drop_id, "FINALIZING");
      }
      if (now.getTime() >= cur.scheduled_at.getTime()) {
        if (cur.status === "READY") {
          cur = await this.transition(cur.drop_id, "RELEASED", { released_at: now });
          await this.publish({ type: "drop.released", dropId: cur.drop_id, startSerial: cur.start_serial, endSerial: cur.end_serial, pancakeCount: cur.pancake_count, heightBefore: cur.height_before, heightAfter: cur.height_after, version: this.store.version });
          this.delayedNotified.delete(cur.drop_id);
        } else if (!this.delayedNotified.has(cur.drop_id) && cur.status !== "OPEN") {
          this.delayedNotified.add(cur.drop_id);
          await this.publish({ type: "drop.delayed", dropId: cur.drop_id, scheduledAt: cur.scheduled_at.toISOString(), status: cur.status, pending: await this.pendingForDrop(cur.drop_id) });
        }
      }
    }
    await this.ensureCurrentDrop();
  }

  private async pendingForDrop(dropId: string): Promise<number> {
    return (await this.db.query<{ n: number }>("SELECT COUNT(*)::int AS n FROM pancakes WHERE drop_id = $1 AND committed_at IS NULL", [dropId])).rows[0].n;
  }

  // ---------------------------------------------------------------- purchases (§7, §8) — 모든 인스턴스
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
    if (this.stopped) return;
    this.queueDirty = true;
    if (this.queueTimer) return;
    this.queueTimer = setTimeout(async () => {
      this.queueTimer = null;
      if (!this.queueDirty) return;
      this.queueDirty = false;
      const d = await this.getDrop(dropId);
      if (d) await this.publish({ type: "drop.queueUpdated", dropId: d.drop_id, queueSize: d.pancake_count, scheduledAt: d.scheduled_at.toISOString() });
    }, this.cfg.queueThrottleMs);
  }

  // ---------------------------------------------------------------- continuous simulation (§26, Phase 3A §4-B pipeline)
  /** 파이프라인을 깨운다 (leader 만 실제로 돈다). */
  kick(): void {
    if (this.running || this.stopped || this.halted || !this.isLeader) return;
    this.running = true;
    this.loopPromise = this.loop().catch((e) => { log.error("pipeline.crashed", { error: String(e) }); }).finally(() => { this.running = false; });
  }

  get pendingPancakes(): number { return this.store.worldState.latest_global_serial - this.store.worldState.committed_serial; }

  private async loop(): Promise<void> {
    while (!this.stopped && !this.halted && this.isLeader) {
      const ws = (await this.db.query<{ latest_global_serial: number; committed_serial: number }>("SELECT latest_global_serial, committed_serial FROM world_state WHERE world_id = $1", [this.cfg.worldId])).rows[0];
      // 커밋이 겹쳐 돌고 있으면 그 job 의 끝 다음부터 (DB committed 는 아직 그 앞일 수 있다)
      const base = this.inflight ? Math.max(ws.committed_serial, this.inflight.end) : ws.committed_serial;
      const pending = ws.latest_global_serial - base;
      if (pending <= 0) { await this.drainInflight(); if (this.inflight) continue; return; }
      if (pending < this.cfg.simBatchSize && this.cfg.simBatchWindowMs > 0) await new Promise((r) => setTimeout(r, this.cfg.simBatchWindowMs));
      const ws2 = (await this.db.query<{ latest_global_serial: number; committed_serial: number }>("SELECT latest_global_serial, committed_serial FROM world_state WHERE world_id = $1", [this.cfg.worldId])).rows[0];
      const base2 = this.inflight ? Math.max(ws2.committed_serial, this.inflight.end) : ws2.committed_serial;
      const start = base2 + 1;
      const end = Math.min(ws2.latest_global_serial, start + this.cfg.simBatchSize - 1);
      if (end < start) { await this.drainInflight(); continue; }
      await this.runJob(start, end);
    }
    await this.drainInflight();
  }

  /** 겹쳐 돌던 커밋을 기다린다. 실패했으면 worker 를 되돌린다. */
  private async drainInflight(): Promise<boolean> {
    if (!this.inflight) return true;
    const f = this.inflight;
    const ok = await f.promise;
    if (this.inflight === f) this.inflight = null;
    if (!ok) { await this.store.refresh(); this.worker.invalidate(); }
    return ok;
  }

  /** attempt 기록 (§16: 모든 시도 보존) */
  private async recordAttempt(jobId: string, dropId: string, attempt: number): Promise<number> {
    const r = await this.db.query<{ attempt_id: number }>("INSERT INTO simulation_attempts (job_id, drop_id, attempt, owner, status) VALUES ($1,$2,$3,$4,'RUNNING') RETURNING attempt_id", [jobId, dropId, attempt, this.instanceId]);
    return r.rows[0].attempt_id;
  }
  private async finishAttempt(attemptId: number, status: "DONE" | "FAILED", ms: number, reason?: FailureReason, error?: string): Promise<void> {
    await this.db.query("UPDATE simulation_attempts SET status = $2, finished_at = now(), duration_ms = $3, failure_reason = $4, error = $5 WHERE attempt_id = $1", [attemptId, status, ms, reason ?? null, error ?? null]);
  }

  private classify(e: unknown): { reason: FailureReason; message: string } {
    if (e instanceof WorkerCrashError) return { reason: "WORKER_CRASH", message: e.message };
    if (e instanceof CommitError) return { reason: e.reason, message: e.message };
    const msg = String((e as Error)?.message ?? e);
    if (/capacity exceeded|not initialised|unexpected .* reply|worker timeout/.test(msg)) return { reason: "SIMULATION_FAILED", message: msg };
    return { reason: "UNKNOWN", message: msg };
  }

  /**
   * job 하나: claim → (worker 보장) → simulate → 커밋을 겹쳐 시작 → 다음 job 으로.
   * 이전 커밋이 실패했으면 이번 결과를 버리고(§4-B: 물리 일관성) worker 를 되돌린다.
   */
  private async runJob(start: number, end: number): Promise<void> {
    const rows = (await this.db.query<{ global_serial: number; country: string; drop_id: string }>("SELECT global_serial, country, drop_id FROM pancakes WHERE global_serial BETWEEN $1 AND $2 ORDER BY global_serial", [start, end])).rows;
    if (rows.length !== end - start + 1) throw new Error(`pancake rows missing for ${start}..${end}`);
    const dropId = rows[0].drop_id;
    const cut = rows.findIndex((r) => r.drop_id !== dropId);
    if (cut > 0) { end = start + cut - 1; rows.length = cut; }
    const countries = new Uint16Array(rows.map((r) => encodeCountry(r.country)));
    const d = await this.getDrop(dropId);
    if (d && d.status === "OPEN") await this.transition(dropId, "SIMULATING", { simulation_started_at: this.clock() });

    // ---- claim (§25): 같은 범위의 job 을 원자적으로 잡는다. 다른 인스턴스가 lease 안에 들고 있으면 건너뛴다.
    const job = await this.claimJob(dropId, start, end);
    if (!job) { this.metrics.claimConflicts++; await new Promise((r) => setTimeout(r, 200)); return; }
    const { jobId, attempt, seed } = job;
    const allowed = this.cfg.workerMaxAttempts * (job.manual_retries + 1);
    if (attempt > allowed) { await this.failJob(job, "UNKNOWN", `max attempts (${allowed}) exceeded`); return; }
    const attemptId = await this.recordAttempt(jobId, dropId, attempt);
    await this.publish({ type: "simulation.started", dropId, jobId, startSerial: start, endSerial: end, attempt });
    const t0 = performance.now();
    const lease = setInterval(() => { void this.db.query("UPDATE simulation_jobs SET lease_expires_at = now() + ($2 || ' milliseconds')::interval WHERE job_id = $1 AND owner = $3", [jobId, String(this.cfg.jobLeaseMs), this.instanceId]).catch(() => undefined); }, Math.max(1000, this.cfg.jobLeaseMs / 3));
    try {
      // worker 가 죽었거나 없으면 이 job 의 input snapshot 으로 INIT (마지막 안전 상태), 아니면 이어서 쌓는다
      // 이전 job 의 커밋이 실패했으면 이 job 은 (그 결과 위에 계획된 것이므로) 버리고 loop 가 이전 범위부터 다시 잡게 한다.
      // 버린 것은 이 job 의 실패가 아니므로 attempt 를 되돌리고 input_snapshot 도 비운다 (다음엔 DB 표면으로 INIT).
      const discard = async (): Promise<void> => {
        this.metrics.discardedResults++;
        await this.db.query("UPDATE simulation_jobs SET status = 'RETRYABLE', owner = NULL, lease_expires_at = NULL, attempt = attempt - 1, input_snapshot = NULL, error = 'discarded: previous commit failed' WHERE job_id = $1 AND owner = $2", [jobId, this.instanceId]);
        await this.finishAttempt(attemptId, "FAILED", performance.now() - t0, "UNKNOWN", "discarded: previous commit failed");
      };
      if (!this.worker.ready || this.workerSpawnedSinceInit > 150_000 || attempt > 1) {
        if (this.inflight && !(await this.drainInflight())) { await discard(); return; } // 되돌리기 전에 겹친 커밋을 정리
        const snap = job.input_snapshot ? new Uint8Array(job.input_snapshot) : await this.store.surfaceSlice();
        await this.worker.reinit(snap); this.workerSpawnedSinceInit = 0;
      }
      const r = await this.worker.simulate(jobId, end - start + 1, seed);
      this.workerSpawnedSinceInit += end - start + 1;
      // 이전 커밋이 실패했다면 이 결과는 잘못된 surface 위에 쌓인 것 → 버린다
      if (this.inflight && !(await this.drainInflight())) { await discard(); return; }
      // 마지막 안전장치: 이 job 이 커밋 순서에 맞는지 (겹친 커밋이 없을 때는 DB committed 바로 다음이어야 한다)
      if (!this.inflight && start !== this.store.committedSerial + 1) { await this.store.refresh(); if (start !== this.store.committedSerial + 1) { await discard(); return; } }
      const commit = this.commitJob(job, r, countries, attemptId, t0);
      if (this.cfg.pipelineOverlap) { this.inflight = { jobId, end, surfaceAfter: r.surfaceAfter, promise: commit }; this.metrics.overlappedCommits++; }
      else await commit;
    } catch (e) {
      const { reason, message } = this.classify(e);
      this.metrics.jobRetries++;
      await this.db.query("UPDATE simulation_jobs SET status = 'RETRYABLE', owner = NULL, lease_expires_at = NULL, error = $2, failure_reason = $3 WHERE job_id = $1 AND owner = $4 AND status = 'RUNNING'", [jobId, message, reason, this.instanceId]);
      await this.finishAttempt(attemptId, "FAILED", performance.now() - t0, reason, message);
      await this.publish({ type: "simulation.failed", dropId, jobId, attempt, reason, error: message, willRetry: attempt < allowed });
      log.warn("simulation.failed", { dropId, jobId, attempt, reason, error: message });
      if (this.inflight) await this.drainInflight();
      await this.store.refresh();
      this.worker.invalidate();
    } finally { clearInterval(lease); }
  }

  /** 커밋 (겹쳐 돌 수 있다). 성공 true / 실패 false — 실패는 job 을 RETRYABLE 로 두고 이유를 남긴다. */
  private async commitJob(job: JobRow & { jobId: string; attempt: number; seed: number }, r: ResultMsg, countries: Uint16Array, attemptId: number, t0: number): Promise<boolean> {
    const { jobId, drop_id: dropId, start_serial: start, end_serial: end, attempt } = job;
    try {
      const final = decodeTower(r.finalTransforms.buffer.slice(r.finalTransforms.byteOffset, r.finalTransforms.byteOffset + r.finalTransforms.byteLength) as ArrayBuffer);
      final.startSerial = start;
      const { version, chunkIds, storageKeys } = await this.store.commit({ jobId, dropId, startSerial: start, endSerial: end, finalTransforms: final, heightUnits: r.heightUnits, countries });
      const ms = performance.now() - t0;
      this.metrics.simJobsMs.push(ms); if (this.metrics.simJobsMs.length > 1000) this.metrics.simJobsMs.shift();
      this.metrics.simPancakes.push({ t: Date.now(), n: end - start + 1 }); if (this.metrics.simPancakes.length > 5000) this.metrics.simPancakes.shift();
      this.metrics.lastJobMetrics = { ...r.metrics, jobId, start, end, chunkIds };
      await this.finishAttempt(attemptId, "DONE", ms);
      const m = await this.store.manifest();
      for (let i = 0; i < chunkIds.length; i++) { const c = m.chunks.find((x) => x.id === chunkIds[i]); if (c) await this.publish({ type: "chunk.committed", chunkId: c.id, version, finalized: c.finalized, checksum: c.checksum, storageKey: storageKeys[i], count: c.count }); }
      await this.publish({ type: "simulation.completed", dropId, jobId, startSerial: start, endSerial: end, durationMs: ms, version });
      await this.publish({ type: "world.updated", version, committedPancakes: end, heightMeters: this.store.worldState.height_meters, latestChunkId: chunkIds[chunkIds.length - 1] });
      log.info("job.committed", { dropId, jobId, worldVersion: version, duration: ms, start, end });
      if (end - this.lastSnapshotSerial >= this.cfg.snapshotEveryPancakes) { await this.store.snapshot(); this.lastSnapshotSerial = end; }
      return true;
    } catch (e) {
      const { reason, message } = this.classify(e);
      this.metrics.jobRetries++;
      await this.db.query("UPDATE simulation_jobs SET status = 'RETRYABLE', owner = NULL, lease_expires_at = NULL, error = $2, failure_reason = $3 WHERE job_id = $1 AND owner = $4 AND status = 'RUNNING'", [jobId, message, reason, this.instanceId]);
      await this.finishAttempt(attemptId, "FAILED", performance.now() - t0, reason, message);
      const allowed = this.cfg.workerMaxAttempts * (job.manual_retries + 1);
      await this.publish({ type: "simulation.failed", dropId, jobId, attempt, reason, error: message, willRetry: attempt < allowed });
      log.error("job.commit_failed", { dropId, jobId, attempt, reason, error: message });
      return false;
    }
  }

  /** job 행 claim (§25). 기존 행이 있으면 PENDING/RETRYABLE 이거나 lease 가 만료된 RUNNING 만 잡는다. */
  private async claimJob(dropId: string, start: number, end: number): Promise<(JobRow & { jobId: string; attempt: number; seed: number }) | null> {
    const leaseMs = String(this.cfg.jobLeaseMs);
    const existing = (await this.db.query<JobRow>(
      `UPDATE simulation_jobs SET status = 'RUNNING', owner = $3, lease_expires_at = now() + ($4 || ' milliseconds')::interval, attempt = attempt + 1, started_at = now()
       WHERE job_id = (SELECT job_id FROM simulation_jobs WHERE start_serial = $1 AND end_serial = $2 AND status <> 'DONE' ORDER BY created_at DESC LIMIT 1)
         AND (status IN ('PENDING','RETRYABLE') OR (status = 'RUNNING' AND (lease_expires_at IS NULL OR lease_expires_at < now())))
       RETURNING *`, [start, end, this.instanceId, leaseMs])).rows[0];
    if (existing) return { ...existing, jobId: existing.job_id, attempt: existing.attempt, seed: existing.seed };
    const any = (await this.db.query<JobRow>("SELECT * FROM simulation_jobs WHERE start_serial = $1 AND end_serial = $2 AND status <> 'DONE' ORDER BY created_at DESC LIMIT 1", [start, end])).rows[0];
    if (any) return null; // 다른 인스턴스가 lease 안에 들고 있거나 FAILED
    const jobId = `job_${randomUUID()}`; const seed = ((start * 2654435761) >>> 0) % 2147483647;
    // input snapshot: 겹쳐 도는 커밋이 있으면 그 job 의 surfaceAfter (worker 가 이미 그 위에 있다), 아니면 DB 표면
    const snapshot = this.inflight ? this.inflight.surfaceAfter : await this.store.surfaceSlice();
    const row = (await this.db.query<JobRow>("INSERT INTO simulation_jobs (job_id, drop_id, start_serial, end_serial, status, attempt, seed, input_snapshot, started_at, owner, lease_expires_at) VALUES ($1,$2,$3,$4,'RUNNING',1,$5,$6, now(), $7, now() + ($8 || ' milliseconds')::interval) RETURNING *", [jobId, dropId, start, end, seed, snapshot ? Buffer.from(snapshot) : null, this.instanceId, leaseMs])).rows[0];
    return { ...row, jobId, attempt: 1, seed };
  }

  private async failJob(job: JobRow, reason: FailureReason, message: string): Promise<void> {
    const r = job.failure_reason as FailureReason | null;
    await this.db.query("UPDATE simulation_jobs SET status = 'FAILED', finished_at = now(), owner = NULL, lease_expires_at = NULL, error = COALESCE(error, $2), failure_reason = COALESCE(failure_reason, $3) WHERE job_id = $1", [job.job_id, message, reason]);
    this.metrics.jobsFailed++;
    await this.transition(job.drop_id, "FAILED", { failure_reason: r ?? reason, failure_error: job.error ?? message }).catch(() => undefined);
    await this.publish({ type: "drop.failed", dropId: job.drop_id, error: `job ${job.job_id} failed after ${job.attempt - 1} attempts: ${job.error ?? message}` });
    log.error("drop.failed", { dropId: job.drop_id, jobId: job.job_id, reason: r ?? reason, error: job.error ?? message });
    this.halted = true; // 무한 retry 금지: 운영자 개입 전까지 파이프라인 정지 (§25)
  }

  // ---------------------------------------------------------------- admin recovery (§14~§16)
  async failedDrops(): Promise<Array<DropRow & { jobs: Array<{ job_id: string; status: string; attempt: number; failure_reason: string | null; error: string | null; attempts: unknown[] }> }>> {
    const drops = (await this.db.query<DropRow>("SELECT * FROM drops WHERE status = 'FAILED' ORDER BY scheduled_at")).rows;
    const out = [];
    for (const d of drops) {
      const jobs = (await this.db.query<{ job_id: string; status: string; attempt: number; failure_reason: string | null; error: string | null }>("SELECT job_id, status, attempt, failure_reason, error FROM simulation_jobs WHERE drop_id = $1 AND status <> 'DONE' ORDER BY start_serial", [d.drop_id])).rows;
      const withAttempts = [];
      for (const j of jobs) withAttempts.push({ ...j, attempts: (await this.db.query("SELECT attempt, owner, status, failure_reason, error, started_at, finished_at, duration_ms FROM simulation_attempts WHERE job_id = $1 ORDER BY attempt", [j.job_id])).rows });
      out.push({ ...d, jobs: withAttempts });
    }
    return out;
  }
  /** retry: FAILED job 을 다시 RETRYABLE 로 (같은 input snapshot, 시도 기록 유지), Drop FAILED → FINALIZING, 파이프라인 재개 */
  async retryDrop(dropId: string, mode: "retry" | "recover" = "retry"): Promise<{ jobs: number }> {
    const d = await this.getDrop(dropId);
    if (!d) throw new Error(`unknown drop ${dropId}`);
    if (d.status !== "FAILED") throw new Error(`drop ${dropId} is ${d.status}, not FAILED`);
    const r = await this.db.query("UPDATE simulation_jobs SET status = 'RETRYABLE', manual_retries = manual_retries + 1, owner = NULL, lease_expires_at = NULL, input_snapshot = CASE WHEN $2 THEN NULL ELSE input_snapshot END WHERE drop_id = $1 AND status = 'FAILED'", [dropId, mode === "recover"]);
    await this.transition(dropId, "FINALIZING", { failure_reason: null, failure_error: null });
    if (mode === "recover") { await this.store.load(); this.worker.invalidate(); } // 저장소 reconcile + worker 를 DB 표면으로 다시
    this.halted = false; this.metrics.recoveries++;
    await this.publish({ type: "drop.recovered", dropId, mode, jobs: r.rowCount ?? 0 });
    log.warn("drop.recovered", { dropId, mode, jobs: r.rowCount ?? 0 });
    this.kick();
    return { jobs: r.rowCount ?? 0 };
  }
  /** abort: 이 Drop 의 미커밋 팬케이크를 다음 Drop 으로 옮긴다 (serial 은 그대로). Drop 은 FAILED 로 남고 aborted_at 를 기록한다. */
  async abortDrop(dropId: string): Promise<{ moved: number; toDropId: string | null }> {
    const d = await this.getDrop(dropId);
    if (!d) throw new Error(`unknown drop ${dropId}`);
    if (d.status !== "FAILED") throw new Error(`drop ${dropId} is ${d.status}, not FAILED`);
    const next = await this.ensureDropRow(this.scheduler.currentDrop(this.clock()));
    const moved = await this.db.tx(async (c) => {
      const r = await c.query<{ n: number; lo: number | null; hi: number | null }>("WITH m AS (UPDATE pancakes SET drop_id = $2 WHERE drop_id = $1 AND committed_at IS NULL RETURNING global_serial) SELECT COUNT(*)::int AS n, MIN(global_serial) AS lo, MAX(global_serial) AS hi FROM m", [dropId, next.drop_id]);
      const { n, lo, hi } = r.rows[0];
      if (n > 0) {
        await c.query("UPDATE drops SET pancake_count = pancake_count - $2 WHERE drop_id = $1", [dropId, n]);
        await c.query("UPDATE drops SET start_serial = LEAST(COALESCE(start_serial, $2), $2), end_serial = GREATEST(COALESCE(end_serial, $3), $3), pancake_count = pancake_count + $4 WHERE drop_id = $1", [next.drop_id, lo, hi, n]);
        await c.query("UPDATE simulation_jobs SET status = 'RETRYABLE', drop_id = $2, manual_retries = manual_retries + 1, owner = NULL, lease_expires_at = NULL WHERE drop_id = $1 AND status = 'FAILED'", [dropId, next.drop_id]);
      }
      await c.query("UPDATE drops SET aborted_at = now(), failure_reason = COALESCE(failure_reason, 'ABORTED') WHERE drop_id = $1", [dropId]);
      return n;
    });
    this.halted = false; this.metrics.recoveries++;
    await this.publish({ type: "drop.aborted", dropId, movedPancakes: moved, toDropId: moved ? next.drop_id : null });
    log.warn("drop.aborted", { dropId, moved, toDropId: next.drop_id });
    this.kick();
    return { moved, toDropId: moved ? next.drop_id : null };
  }

  // ---------------------------------------------------------------- read models
  async snapshotEvent(): Promise<Extract<WorldEvent, { type: "world.snapshot" }>> {
    const d = await this.currentDrop();
    const ws = this.store.worldState;
    const summary: DropSummary = { dropId: d.drop_id, status: d.status, scheduledAt: d.scheduled_at.toISOString(), cutoffAt: d.cutoff_at.toISOString(), pancakeCount: d.pancake_count, queueSize: d.pancake_count };
    return { type: "world.snapshot", version: ws.version, totalPancakes: ws.latest_global_serial, committedPancakes: ws.committed_serial, heightMeters: ws.height_meters, currentDrop: summary, nextDropAt: d.scheduled_at.toISOString(), serverTime: this.clock().toISOString(), lastEventId: await this.eventLog.latestId(), instanceId: this.instanceId };
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

  /** readiness (§27): DB, 저장소, (leader 면) worker */
  async readiness(): Promise<{ ready: boolean; checks: Record<string, { ok: boolean; ms?: number; detail?: string }> }> {
    const checks: Record<string, { ok: boolean; ms?: number; detail?: string }> = {};
    const t0 = performance.now();
    try { await this.db.query("SELECT 1"); checks.db = { ok: true, ms: performance.now() - t0 }; } catch (e) { checks.db = { ok: false, detail: String(e) }; }
    const t1 = performance.now();
    try { await this.store.storage.list(`worlds/${this.cfg.worldId}/chunks/`); checks.storage = { ok: true, ms: performance.now() - t1 }; } catch (e) { checks.storage = { ok: false, detail: String(e) }; }
    checks.leader = { ok: true, detail: this.isLeader ? `leader (${this.instanceId})` : "follower" };
    checks.worker = { ok: !this.isLeader || !this.halted, detail: this.halted ? "pipeline halted (FAILED drop)" : this.isLeader ? (this.worker.alive ? "alive" : "idle") : "n/a" };
    return { ready: Object.values(checks).every((c) => c.ok), checks };
  }

  metricsSnapshot(): Record<string, unknown> {
    const now = Date.now();
    const per = (arr: number[], p: number): number => { if (!arr.length) return 0; const s = [...arr].sort((a, b) => a - b); return s[Math.floor((s.length - 1) * p)]; };
    const recent = this.metrics.simPancakes.filter((x) => now - x.t < 60_000).reduce((a, x) => a + x.n, 0);
    const sm = this.store.metrics;
    const st = (this.store.storage as { metrics?: Record<string, number> }).metrics;
    return {
      instanceId: this.instanceId, leader: this.isLeader, leaderTerm: this.leader.term, pipelineHalted: this.halted,
      worldTotal: this.store.worldState.latest_global_serial, worldCommitted: this.store.committedSerial, worldVersion: this.store.version, heightMeters: this.store.worldState.height_meters,
      purchaseEventsPerSec: this.metrics.purchaseEvents.filter((t) => now - t < 10_000).length / 10,
      pendingSimulationPancakes: this.pendingPancakes,
      simulationThroughputPerSec: recent / 60,
      simulationJobP50Ms: per(this.metrics.simJobsMs, 0.5), simulationJobP95Ms: per(this.metrics.simJobsMs, 0.95),
      workerCrashes: this.metrics.workerCrashes, workerRestarts: this.worker.restarts, jobRetries: this.metrics.jobRetries, jobsFailed: this.metrics.jobsFailed, recoveries: this.metrics.recoveries,
      overlappedCommits: this.metrics.overlappedCommits, discardedResults: this.metrics.discardedResults, claimConflicts: this.metrics.claimConflicts,
      dropFinalizeMsP50: per(this.metrics.dropFinalizeMs, 0.5), dropFinalizeMsMax: per(this.metrics.dropFinalizeMs, 1),
      dbQueries: this.db.metrics.queries, dbLatencyP50Ms: this.db.latencyP(0.5), dbLatencyP95Ms: this.db.latencyP(0.95),
      chunkEncodeMsAvg: sm.commits ? sm.encodeMs / sm.commits : 0, storageUploadMsAvg: sm.commits ? sm.storageUploadMs / sm.commits : 0, storageVerifyMsAvg: sm.commits ? sm.storageVerifyMs / sm.commits : 0, dbTxMsAvg: sm.commits ? sm.dbTxMs / sm.commits : 0,
      chunkWriteMsAvg: sm.chunkWrites ? sm.chunkWriteMs / sm.chunkWrites : 0, chunkWrites: sm.chunkWrites,
      commitMsAvg: sm.commits ? sm.commitMs / sm.commits : 0, commits: sm.commits, promotions: sm.promotions,
      storage: st ?? null,
      manifestMs: sm.manifestMs, snapshots: sm.snapshots, recoveredFiles: sm.recoveredFiles,
      events: { ...this.eventLog.metrics },
      websocketClients: this.metrics.wsClients, pipelineRunning: this.running, pipelineStopped: this.stopped,
      lastJob: this.metrics.lastJobMetrics,
    };
  }
}
