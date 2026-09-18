/**
 * Object storage 벤치 (Phase 3A §29~§31): 1M (또는 10M) 합성 월드를 S3 호환 저장소에 올리고 manifest / chunk / Find 조회를 잰다.
 *   (s3 mock) pnpm --filter world-server s3:mock  →  STORAGE_KIND=object S3_ENDPOINT=http://127.0.0.1:9000 S3_BUCKET=pancake S3_ACCESS_KEY_ID=S3RVER S3_SECRET_ACCESS_KEY=S3RVER \
 *            pnpm --filter world-server bench:storage -- --count 1000000 [--db postgres://.../pancake_bench] [--out ../../docs/benchmarks/phase3a-storage-1m.json]
 * 단계: seed (DB 행 + chunk 인코딩 + 저장소 업로드) → 서버 없이 WorldStore 로 cold start(reconcile) → manifest 크기/시간 → chunk 무작위 조회 (cold/warm) → Find #N 조회 경로.
 */
import { writeFileSync } from "node:fs";
import { encodeCountry } from "pancake-core";
import { DEFAULT_TOWER_CONFIG, buildChunk, decodeChunk, encodeChunk, generateSyntheticTower } from "tower-engine";
import { loadConfig } from "../src/config";
import { Db } from "../src/db/db";
import { chunkKey, createChunkStorage, stagingKey } from "../src/world/chunkStorage";
import { WorldStore, sha256 } from "../src/world/worldStore";

const argv = process.argv.slice(2);
const opt = (k: string, d: string): string => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const count = Number(opt("--count", "1000000"));
const out = opt("--out", "");
const cfg = loadConfig({ databaseUrl: opt("--db", process.env.BENCH_DATABASE_URL ?? "postgres://pancake:pancake@127.0.0.1:5432/pancake_test"), chunkSize: Number(opt("--chunk-size", "10000")) });
const COUNTRIES = ["KR", "JP", "US", "BR", "ID", "ZZ"];
const per = (a: number[], p: number): number => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.floor((s.length - 1) * p)]; };
const rss = (): number => Math.round(process.memoryUsage().rss / 1e6);

const db = new Db(cfg.databaseUrl);
await db.migrate(); await db.reset();
const storage = createChunkStorage(cfg);
for (const k of await storage.list(`worlds/${cfg.worldId}/`)) await storage.delete(k);
const towerCfg = { ...DEFAULT_TOWER_CONFIG, chunkSize: cfg.chunkSize };
const nChunks = Math.ceil(count / cfg.chunkSize);
console.log(`seeding ${count} pancakes / ${nChunks} chunks into ${cfg.storageKind} storage (rss ${rss()} MB)…`);

// 1) seed: chunk 단위로 생성해 메모리를 아낀다 (10M 도 가능)
const T0 = performance.now();
let bytesTotal = 0; const uploadMs: number[] = []; let heightUnits = 0;
await db.query("INSERT INTO drops (drop_id, scheduled_at, cutoff_at, status, start_serial, end_serial, pancake_count, height_before, height_after, released_at) VALUES ('drop_synthetic', now(), now(), 'RELEASED', 1, $1::bigint, $2::int, 0, 0, now())", [count, count]);
let y = 0;
for (let id = 0; id < nChunks; id++) {
  const from = id * cfg.chunkSize, n = Math.min(cfg.chunkSize, count - from);
  const set = generateSyntheticTower(n, towerCfg, 42 + id, from);
  for (let i = 0; i < n; i++) { set.py[i] += y; set.country![i] = encodeCountry(COUNTRIES[((from + i) * 7919) % COUNTRIES.length]); }
  y = set.py[n - 1] + (set.thickness * set.tscale[n - 1]) / 2; heightUnits = y;
  const chunk = buildChunk(set, id, 0, n, towerCfg);
  const bytes = new Uint8Array(encodeChunk(chunk, towerCfg)); const checksum = sha256(bytes); bytesTotal += bytes.byteLength;
  const finalized = n === cfg.chunkSize; const key = finalized ? chunkKey(cfg.worldId, id, 1) : stagingKey(cfg.worldId, id, 1);
  const t = performance.now(); await storage.put(key, bytes, { sha256: checksum }); uploadMs.push(performance.now() - t);
  await db.query("INSERT INTO chunks (chunk_id, start_serial, end_serial, count, min_height, max_height, checksum, byte_length, finalized, version, data, bounds, storage_key) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,1,$10,$11,$12)", [id, from + 1, from + n, n, chunk.minHeight, chunk.maxHeight, checksum, bytes.byteLength, finalized, Buffer.from(bytes), JSON.stringify(chunk.bounds), key]);
  if (id % 50 === 49 || id === nChunks - 1) process.stdout.write(`  chunks ${id + 1}/${nChunks} (${((performance.now() - T0) / 1000).toFixed(0)} s, rss ${rss()} MB)   \r`);
}
console.log();
const tp = performance.now();
for (let s = 1; s <= count; s += 1_000_000) {
  const e = Math.min(count, s + 999_999);
  await db.query(`INSERT INTO pancakes (pancake_id, global_serial, country, country_serial, drop_id, order_id, chunk_id, instance_index, variant, committed_at)
    SELECT s, s, c, ((s - 1) / $5) + 1, 'drop_synthetic', 'order_synthetic', ((s - 1) / $3)::int, ((s - 1) % $3)::int, 0, now() FROM (SELECT s, ($4::text[])[((s - 1) * 7919) % $5 + 1] AS c FROM generate_series($1::bigint, $2::bigint) AS s) t`, [s, e, cfg.chunkSize, COUNTRIES, COUNTRIES.length]);
  process.stdout.write(`  pancake rows ${e}/${count} (${((performance.now() - tp) / 1000).toFixed(0)} s)   \r`);
}
console.log();
// country 는 ((s-1)*7919) mod 6 = ((s-1)*5) mod 6 → 연속 6 serial 마다 6개 국가가 한 번씩 → country_serial = (s-1) div 6 + 1 이 국가별 1..N 연속 (10M 행 UPDATE 회피)
const tc = performance.now();
await db.query("INSERT INTO country_counters (country, latest_serial) SELECT country, COUNT(*) FROM pancakes GROUP BY country ON CONFLICT (country) DO UPDATE SET latest_serial = EXCLUDED.latest_serial");
const heightMeters = (heightUnits * towerCfg.unitCm) / 100;
await db.query("INSERT INTO world_state (world_id, latest_global_serial, committed_serial, height_meters, height_units, latest_chunk_id, version) VALUES ($1, $2::bigint, $2::bigint, $3, $4, $5, 1) ON CONFLICT (world_id) DO UPDATE SET latest_global_serial = EXCLUDED.latest_global_serial, committed_serial = EXCLUDED.committed_serial, height_meters = EXCLUDED.height_meters, height_units = EXCLUDED.height_units, latest_chunk_id = EXCLUDED.latest_chunk_id, version = 1", [cfg.worldId, count, heightMeters, heightUnits, nChunks - 1]);
const seedS = (performance.now() - T0) / 1000;
const dbSize = (await db.query<{ s: string; b: number }>("SELECT pg_size_pretty(pg_database_size(current_database())) AS s, pg_database_size(current_database())::bigint AS b")).rows[0];
const tableSizes = (await db.query<{ t: string; s: string }>("SELECT relname AS t, pg_size_pretty(pg_total_relation_size(oid)) AS s FROM pg_class WHERE relname IN ('pancakes','chunks','world_events','simulation_jobs') ORDER BY relname")).rows;
console.log(`seed ${seedS.toFixed(0)} s: ${(bytesTotal / 1048576).toFixed(1)} MB chunk bytes, upload p50 ${per(uploadMs, 0.5).toFixed(1)} ms / p95 ${per(uploadMs, 0.95).toFixed(1)} ms, country serial pass ${((performance.now() - tc) / 1000).toFixed(0)} s, db ${dbSize.s}`);

// 2) cold start: WorldStore.load → reconcile (모든 chunk HEAD)
const store = new WorldStore(db, storage, cfg);
const tl = performance.now(); await store.load(); const coldStartMs = performance.now() - tl;
// 3) manifest
const tm = performance.now(); const manifest = await store.manifest(); const manifestMs = performance.now() - tm;
const manifestBytes = Buffer.byteLength(JSON.stringify(manifest));
// 4) chunk retrieval: storage cold (첫 조회) vs warm (재조회), DB bytes 경로
const ids = Array.from({ length: 50 }, (_, i) => Math.floor((i * 7919) % nChunks));
const coldMs: number[] = [], warmMs: number[] = [], dbMs: number[] = [];
for (const id of ids) { const c = manifest.chunks[id]; const t = performance.now(); const b = await storage.get(c.storageKey!); coldMs.push(performance.now() - t); if (!b || sha256(b) !== c.checksum) throw new Error(`chunk ${id} integrity`); }
for (const id of ids) { const c = manifest.chunks[id]; const t = performance.now(); await storage.get(c.storageKey!); warmMs.push(performance.now() - t); }
for (const id of ids) { const t = performance.now(); await store.chunkBytes(id); dbMs.push(performance.now() - t); }
// 5) Find #N: pancakes 행 → chunk → transform (서버 조회 경로), 그리고 클라이언트가 받을 chunk 수 = 1
const finds = [1, 54321, Math.floor(count / 2), count - 1, count];
const findMs: number[] = [];
for (const serial of finds) {
  const t = performance.now();
  const p = (await db.query<{ chunk_id: number; instance_index: number }>("SELECT chunk_id, instance_index FROM pancakes WHERE global_serial = $1", [serial])).rows[0];
  const b = (await storage.get(manifest.chunks[p.chunk_id].storageKey!))!;
  const ch = decodeChunk(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer).chunk;
  const yy = ch.transforms[p.instance_index * 9 + 1];
  findMs.push(performance.now() - t);
  if (!(yy > 0)) throw new Error("find transform");
}
const result = { count, chunks: nChunks, storageKind: cfg.storageKind, seedSeconds: seedS, chunkBytes: bytesTotal, uploadMsP50: per(uploadMs, 0.5), uploadMsP95: per(uploadMs, 0.95), dbSize: dbSize.s, dbBytes: dbSize.b, tableSizes, coldStartMs, manifestMs, manifestBytes, manifestBytesPerChunk: manifestBytes / nChunks, chunkGetColdMsP50: per(coldMs, 0.5), chunkGetColdMsP95: per(coldMs, 0.95), chunkGetWarmMsP50: per(warmMs, 0.5), chunkGetDbMsP50: per(dbMs, 0.5), findMs: Object.fromEntries(finds.map((f, i) => [f, findMs[i]])), heightMeters, rssMB: rss(), storageMetrics: (storage as { metrics?: unknown }).metrics ?? null };
console.log(JSON.stringify(result, null, 1));
if (out) { writeFileSync(out, JSON.stringify(result, null, 2)); console.log(`wrote ${out}`); }
await store.close(); await db.close();
