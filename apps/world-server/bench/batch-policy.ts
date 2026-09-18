/**
 * 연속 시뮬레이션 batch 정책 벤치 (Phase 2 §27): batch 10 … 1000 으로 같은 양을 처리하며
 * 처리량 / 벽시계 / 메모리 / 모양 / IPC+커밋 오버헤드를 비교한다.
 *   pnpm --filter world-server bench:batch -- [--count 5000] [--batches 10,50,100,250,500,1000] [--out ../../docs/benchmarks/phase2-batch-policy.json]
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorldApp } from "../src/app";
import { loadConfig } from "../src/config";
import { Db } from "../src/db/db";
import { ensureWorld } from "../src/world/serial";
import { LocalChunkStorage } from "../src/world/chunkStorage";

const argv = process.argv.slice(2);
const opt = (k: string, d: string): string => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const count = Number(opt("--count", "5000"));
const batches = opt("--batches", "10,50,100,250,500,1000").split(",").map(Number);
const out = opt("--out", "");
const overlap = opt("--overlap", "1") === "1"; // Phase 3A §4-B pipeline (물리와 커밋 겹침)
const dbUrl = opt("--db", process.env.BENCH_DATABASE_URL ?? "postgres://pancake:pancake@127.0.0.1:5432/pancake_test");
const per = (a: number[], p: number): number => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.floor((s.length - 1) * p)]; };
const sum = (a: number[]): number => a.reduce((x, y) => x + y, 0);

const results = [];
for (const batch of batches) {
  const dir = mkdtempSync(join(tmpdir(), "pancake-batch-"));
  const cfg = loadConfig({ databaseUrl: dbUrl, dataDir: dir, chunkSize: 10_000, simBatchSize: batch, simBatchWindowMs: 0, snapshotEveryPancakes: 1e9, pipelineOverlap: overlap });
  const now = new Date("2026-09-18T03:02:00.000Z");
  const db = new Db(dbUrl); await db.dropAll(); await db.migrate(); await ensureWorld(db, cfg.worldId);
  const app = new WorldApp({ db, storage: new LocalChunkStorage(join(dir, "chunks")), config: cfg, clock: () => now, cluster: false });
  const jm: { wall: number; worker: number; penP95: number; penMax: number; tilt: number; leaks: number; active: number }[] = [];
  app.events.onEvent((e) => { if (e.type === "world.updated") { const m = app.metrics.lastJobMetrics as any; jm.push({ wall: app.metrics.simJobsMs[app.metrics.simJobsMs.length - 1], worker: m.wallMs, penP95: m.penetrationP95, penMax: m.penetrationMax, tilt: m.tiltMedian, leaks: m.leaks, active: m.maxActive }); } });
  await app.start();
  // 구매를 먼저 전부 넣고(파이프라인이 도는 동안) 다 빌 때까지 잰다
  const t0 = performance.now(); let rssPeak = 0;
  let allocated = 0;
  while (allocated < count) { const reqs = []; for (let i = 0; i < 20 && allocated < count; i++) { const q = Math.min(1 + Math.floor(Math.random() * 10), count - allocated); allocated += q; reqs.push(app.purchase({ quantity: q, country: "KR" })); } await Promise.all(reqs); }
  const tAlloc = performance.now();
  while (true) { await app.store.refresh(); rssPeak = Math.max(rssPeak, process.memoryUsage().rss); if (app.pendingPancakes === 0) break; app.kick(); await new Promise((r) => setTimeout(r, 100)); }
  const wall = (performance.now() - t0) / 1000;
  const m = app.metricsSnapshot() as any;
  const ms = app.metricsSnapshot() as any;
  const r = {
    batch, count, overlap, wallSeconds: wall, purchaseSeconds: (tAlloc - t0) / 1000, throughputPerSec: count / wall, jobs: jm.length,
    jobWallP50Ms: per(jm.map((j) => j.wall), 0.5), jobWallP95Ms: per(jm.map((j) => j.wall), 0.95), workerWallP50Ms: per(jm.map((j) => j.worker), 0.5),
    overheadMsPerJob: jm.length ? sum(jm.map((j) => j.wall - j.worker)) / jm.length : 0, overheadShare: sum(jm.map((j) => j.wall)) ? sum(jm.map((j) => j.wall - j.worker)) / sum(jm.map((j) => j.wall)) : 0,
    commitMsAvg: m.commitMsAvg, commits: m.commits, worldVersion: app.store.version,
    penetrationP95Max: Math.max(...jm.map((j) => j.penP95)), penetrationMaxMax: Math.max(...jm.map((j) => j.penMax)), tiltMedianAvg: sum(jm.map((j) => j.tilt)) / jm.length, leaks: sum(jm.map((j) => j.leaks)), maxActive: Math.max(...jm.map((j) => j.active)),
    heightMeters: app.store.worldState.height_meters, rssPeakMB: Math.round(rssPeak / 1e6), workerCrashes: m.workerCrashes, jobRetries: m.jobRetries,
    encodeMsAvg: ms.chunkEncodeMsAvg, storageUploadMsAvg: ms.storageUploadMsAvg, dbTxMsAvg: ms.dbTxMsAvg, overlappedCommits: ms.overlappedCommits, discardedResults: ms.discardedResults,
  };
  results.push(r);
  console.log(`batch ${String(batch).padStart(4)} overlap=${overlap ? 1 : 0}: ${wall.toFixed(1)} s, ${r.throughputPerSec.toFixed(0)} pc/s, jobs ${r.jobs}, job p50 ${r.jobWallP50Ms.toFixed(0)} ms (worker ${r.workerWallP50Ms.toFixed(0)} ms, overhead ${r.overheadMsPerJob.toFixed(1)} ms = ${(r.overheadShare * 100).toFixed(0)}%), commit ${r.commitMsAvg.toFixed(1)} ms ×${r.commits}, pen p95 ${r.penetrationP95Max.toFixed(3)} max ${r.penetrationMaxMax.toFixed(3)}, tilt ${r.tiltMedianAvg.toFixed(3)}, leaks ${r.leaks}, height ${r.heightMeters.toFixed(2)} m, rss ${r.rssPeakMB} MB`);
  await app.stop(); await db.close(); rmSync(dir, { recursive: true, force: true });
}
if (out) { writeFileSync(out, JSON.stringify({ count, overlap, results }, null, 2)); console.log(`wrote ${out}`); }
