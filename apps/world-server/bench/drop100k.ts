/**
 * 100k 연속 Drop 테스트 (Phase 2 §44): 한 Drop 에 100,000 장을 구매 → cutoff → 연속 시뮬레이션 → READY → RELEASED.
 *   pnpm --filter world-server bench:drop100k -- [--count 100000] [--batch 100] [--db postgres://.../pancake_bench] [--out ../../docs/benchmarks/phase2-drop100k.json]
 * 실제 worker(자식 프로세스) + 실제 DB + 로컬 파일 저장소를 쓴다. 시계는 가짜(고정)라 Drop 상태 전이를 즉시 밟는다.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorldApp } from "../src/app";
import { loadConfig } from "../src/config";
import { Db } from "../src/db/db";
import { ensureWorld } from "../src/world/serial";
import { LocalChunkStorage } from "../src/world/chunkStorage";
import type { WorldEvent } from "../src/world/events";

const argv = process.argv.slice(2);
const opt = (k: string, d: string): string => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const count = Number(opt("--count", "100000"));
const batch = Number(opt("--batch", "100"));
const out = opt("--out", "");
const overlap = opt("--overlap", "1") === "1"; // Phase 3A §4-B pipeline (물리와 커밋 겹침)
const dbUrl = opt("--db", process.env.BENCH_DATABASE_URL ?? "postgres://pancake:pancake@127.0.0.1:5432/pancake_test");
const dir = mkdtempSync(join(tmpdir(), "pancake-drop100k-"));
const cfg = loadConfig({ databaseUrl: dbUrl, dataDir: dir, chunkSize: 10_000, simBatchSize: batch, simBatchWindowMs: 0, snapshotEveryPancakes: 10_000, dropIntervalSeconds: 600, dropCutoffSeconds: 60, pipelineOverlap: overlap });

let now = new Date("2026-09-18T03:02:00.000Z"); // drop_20260918T031000Z, cutoff 03:09:00
const db = new Db(dbUrl);
await db.dropAll(); await db.migrate(); await ensureWorld(db, cfg.worldId);
const app = new WorldApp({ db, storage: new LocalChunkStorage(join(dir, "chunks")), config: cfg, clock: () => now, cluster: false });
const events: Record<string, number> = {}; const timeline: { t: number; type: string; detail?: string }[] = [];
const jobMetrics: { n: number; wallMs: number; workerWallMs: number; penP95: number; penMax: number; tilt: number; leaks: number; maxActive: number }[] = [];
const T0 = performance.now();
app.events.onEvent((e: WorldEvent) => {
  events[e.type] = (events[e.type] ?? 0) + 1;
  if (e.type === "world.updated") { const m = app.metrics.lastJobMetrics as any; const last = app.metrics.simJobsMs[app.metrics.simJobsMs.length - 1]; jobMetrics.push({ n: (m.end - m.start + 1), wallMs: last, workerWallMs: m.wallMs, penP95: m.penetrationP95, penMax: m.penetrationMax, tilt: m.tiltMedian, leaks: m.leaks, maxActive: m.maxActive }); }
  else timeline.push({ t: (performance.now() - T0) / 1000, type: e.type, detail: "dropId" in e ? e.dropId : undefined });
});
await app.start();
const rss = (): number => Math.round(process.memoryUsage().rss / 1e6);

// 1) 구매: 1~10 장씩, 50 개 동시
console.log(`purchasing ${count} pancakes (qty 1..10, 50 concurrent)…`);
const tp = performance.now(); let allocated = 0, orders = 0;
while (allocated < count) {
  const batchReqs = [];
  for (let i = 0; i < 50 && allocated < count; i++) { const q = Math.min(1 + Math.floor(Math.random() * 10), count - allocated); allocated += q; batchReqs.push(app.purchase({ quantity: q, country: ["KR", "US", "JP", "DE", "BR"][orders++ % 5] })); }
  await Promise.all(batchReqs);
  if (orders % 2000 < 50) process.stdout.write(`  allocated ${allocated} (${((performance.now() - tp) / 1000).toFixed(0)} s)   \r`);
}
const purchaseS = (performance.now() - tp) / 1000;
console.log(`\npurchases: ${orders} orders, ${allocated} pancakes in ${purchaseS.toFixed(1)} s (${(orders / purchaseS).toFixed(0)} orders/s); pipeline already committed ${app.store.committedSerial}`);

// 2) cutoff → CLOSING → 파이프라인이 다 빌 때까지
now = new Date("2026-09-18T03:09:00.000Z"); await app.tick();
const ts = performance.now(); let lastLog = 0;
while (true) {
  await app.store.refresh();
  if (app.pendingPancakes === 0) break;
  app.kick();
  if (performance.now() - lastLog > 5000) { lastLog = performance.now(); const m = app.metricsSnapshot() as any; process.stdout.write(`  simulating: committed ${app.store.committedSerial}/${allocated} ${(m.simulationThroughputPerSec as number).toFixed(0)}/s job p50 ${(m.simulationJobP50Ms as number).toFixed(0)} ms rss ${rss()} MB height ${app.store.worldState.height_meters.toFixed(1)} m   \r`); }
  await new Promise((r) => setTimeout(r, 200));
}
await app.tick(); // → READY (+snapshot)
const simS = (performance.now() - T0) / 1000, drainS = (performance.now() - ts) / 1000;
now = new Date("2026-09-18T03:10:00.000Z"); await app.tick(); // → RELEASED
console.log();
const drop = (await app.getDrop("drop_20260918T031000Z"))!;
const m = app.metricsSnapshot() as any;
const dbSize = (await db.query<{ s: string; b: number }>("SELECT pg_size_pretty(pg_database_size(current_database())) AS s, pg_database_size(current_database())::bigint AS b")).rows[0];
const committedRows = (await db.query<{ n: number }>("SELECT COUNT(*)::int AS n FROM pancakes WHERE committed_at IS NOT NULL")).rows[0].n;
const jobs = (await db.query<{ status: string; n: number }>("SELECT status, COUNT(*)::int AS n FROM simulation_jobs GROUP BY status")).rows;
const snapshots = (await db.query<{ n: number }>("SELECT COUNT(*)::int AS n FROM world_snapshots")).rows[0].n;
const manifest = await app.store.manifest();
const per = (a: number[], p: number): number => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.floor((s.length - 1) * p)]; };
const sum = (a: number[]): number => a.reduce((x, y) => x + y, 0);
const result = {
  count, batch, overlap, orders, purchaseSeconds: purchaseS, totalSeconds: simS, drainAfterCutoffSeconds: drainS,
  throughputPerSec: count / simS, drop: { status: drop.status, pancakeCount: drop.pancake_count, heightBefore: drop.height_before, heightAfter: drop.height_after, startSerial: drop.start_serial, endSerial: drop.end_serial },
  world: { version: app.store.version, committed: app.store.committedSerial, heightMeters: app.store.worldState.height_meters, chunks: manifest.chunks.length, finalizedChunks: manifest.chunks.filter((c) => c.finalized).length, chunkBytes: sum(manifest.chunks.map((c) => c.byteLength)) },
  jobs: { total: jobMetrics.length, wallP50Ms: per(jobMetrics.map((j) => j.wallMs), 0.5), wallP95Ms: per(jobMetrics.map((j) => j.wallMs), 0.95), workerWallP50Ms: per(jobMetrics.map((j) => j.workerWallMs), 0.5), ipcAndCommitOverheadMsAvg: sum(jobMetrics.map((j) => j.wallMs - j.workerWallMs)) / jobMetrics.length, maxActiveMax: Math.max(...jobMetrics.map((j) => j.maxActive)), statuses: jobs },
  shape: { penetrationP95Max: Math.max(...jobMetrics.map((j) => j.penP95)), penetrationMaxMax: Math.max(...jobMetrics.map((j) => j.penMax)), tiltMedianAvg: sum(jobMetrics.map((j) => j.tilt)) / jobMetrics.length, leaks: sum(jobMetrics.map((j) => j.leaks)) },
  pipeline: { overlappedCommits: m.overlappedCommits, discardedResults: m.discardedResults, encodeMsAvg: m.chunkEncodeMsAvg, storageUploadMsAvg: m.storageUploadMsAvg, dbTxMsAvg: m.dbTxMsAvg, dbLatencyP95Ms: m.dbLatencyP95Ms },
  store: { commitMsAvg: m.commitMsAvg, commits: m.commits, chunkWriteMsAvg: m.chunkWriteMsAvg, chunkWrites: m.chunkWrites, snapshots, workerCrashes: m.workerCrashes, workerRestarts: m.workerRestarts, jobRetries: m.jobRetries },
  consistency: { committedRows, allocated, ok: committedRows === allocated && app.store.committedSerial === allocated && drop.pancake_count === allocated },
  events, timeline, memory: { rssMB: rss(), dbSize: dbSize.s, dbBytes: dbSize.b },
};
console.log(JSON.stringify({ ...result, timeline: undefined }, null, 2));
if (out) { writeFileSync(out, JSON.stringify(result, null, 2)); console.log(`wrote ${out}`); }
await app.stop(); await db.close(); rmSync(dir, { recursive: true, force: true });
