/**
 * 합성 1M 월드를 DB + chunk 저장소에 심는다 (Phase 2 §45). 물리 없음 — 스트리밍/검색/영속성 검증 전용.
 *   pnpm --filter world-server seed:synthetic -- --count 1000000 [--db postgres://...] [--data-dir ./data] [--chunk-size 10000]
 * 기존 world 데이터는 모두 지운다(TRUNCATE). 실제 서비스 탑은 항상 서버 물리 결과에서 온다.
 */
import { encodeCountry } from "pancake-core";
import { DEFAULT_TOWER_CONFIG, buildChunk, encodeChunk, generateSyntheticTower } from "tower-engine";
import { loadConfig } from "../src/config";
import { Db } from "../src/db/db";
import { chunkKey, createChunkStorage, stagingKey } from "../src/world/chunkStorage";
import { sha256 } from "../src/world/worldStore";

const argv = process.argv.slice(2);
const opt = (k: string, d: string): string => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const count = Number(opt("--count", "1000000"));
const cfg = loadConfig({ databaseUrl: opt("--db", process.env.DATABASE_URL ?? "postgres://pancake:pancake@127.0.0.1:5432/pancake_world"), dataDir: opt("--data-dir", process.env.DATA_DIR ?? "./data"), chunkSize: Number(opt("--chunk-size", process.env.CHUNK_SIZE ?? "10000")) });
const COUNTRIES = ["KR", "US", "JP", "DE", "FR", "GB", "BR", "IN", "CA", "AU", "MX", "ES", "IT", "NL", "SE", "TR", "ID", "VN", "TH", "ZZ"];

const t0 = performance.now();
const db = new Db(cfg.databaseUrl);
await db.migrate();
await db.reset();
const storage = createChunkStorage(cfg);
for (const key of await storage.list(`worlds/${cfg.worldId}/`)) await storage.delete(key);

const towerCfg = { ...DEFAULT_TOWER_CONFIG, chunkSize: cfg.chunkSize };
console.log(`generating ${count} synthetic pancakes (chunk ${cfg.chunkSize})…`);
const set = generateSyntheticTower(count, towerCfg, 42, 0);
// 국가: 결정적 해시 분포
for (let i = 0; i < count; i++) set.country![i] = encodeCountry(COUNTRIES[(i * 7919) % COUNTRIES.length]);
let heightUnits = 0;
for (let i = 0; i < count; i++) heightUnits = Math.max(heightUnits, set.py[i] + (set.thickness * set.tscale[i]) / 2);
const heightMeters = (heightUnits * towerCfg.unitCm) / 100;

const dropId = "drop_synthetic";
await db.query("INSERT INTO drops (drop_id, scheduled_at, cutoff_at, status, start_serial, end_serial, pancake_count, height_before, height_after, released_at) VALUES ($1, now(), now(), 'RELEASED', 1, $2::bigint, $4::int, 0, $3, now())", [dropId, count, heightMeters, count]);
await db.query("INSERT INTO orders (order_id, quantity, country, drop_id, start_serial, end_serial, status) VALUES ('order_synthetic', $1::int, 'ZZ', $2, 1, $3::bigint, 'ALLOCATED')", [count, dropId, count]);

// chunks (DB authoritative + 파일)
const nChunks = Math.ceil(count / cfg.chunkSize);
let bytesTotal = 0;
for (let id = 0; id < nChunks; id++) {
  const from = id * cfg.chunkSize, to = Math.min(count, from + cfg.chunkSize);
  const chunk = buildChunk(set, id, from, to, towerCfg);
  const bytes = new Uint8Array(encodeChunk(chunk, towerCfg));
  const checksum = sha256(bytes);
  bytesTotal += bytes.byteLength;
  const finalized = chunk.count === cfg.chunkSize;
  const key = finalized ? chunkKey(cfg.worldId, id, 1) : stagingKey(cfg.worldId, id, 1);
  await storage.put(key, bytes, { sha256: checksum });
  await db.query(
    "INSERT INTO chunks (chunk_id, start_serial, end_serial, count, min_height, max_height, checksum, byte_length, finalized, version, data, bounds, storage_key) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,1,$10,$11,$12)",
    [id, chunk.startSerial + 1, chunk.endSerial + 1, chunk.count, chunk.minHeight, chunk.maxHeight, checksum, bytes.byteLength, finalized, Buffer.from(bytes), JSON.stringify(chunk.bounds), key],
  );
  if (id % 10 === 9 || id === nChunks - 1) process.stdout.write(`  chunks ${id + 1}/${nChunks}\r`);
}
console.log();

// pancakes: 1 INSERT … SELECT (country_serial 은 국가별 row_number)
console.log("inserting pancake rows…");
const tp = performance.now();
await db.query(
  `INSERT INTO pancakes (pancake_id, global_serial, country, country_serial, drop_id, order_id, chunk_id, instance_index, variant, committed_at)
   SELECT s, s, c, row_number() OVER (PARTITION BY c ORDER BY s), $2, 'order_synthetic', ((s - 1) / $3)::int, ((s - 1) % $3)::int, 0, now()
   FROM (SELECT s, ($4::text[])[((s - 1) * 7919) % $5 + 1] AS c FROM generate_series(1, $1::bigint) AS s) t`,
  [count, dropId, cfg.chunkSize, COUNTRIES, COUNTRIES.length],
);
await db.query("INSERT INTO country_counters (country, latest_serial) SELECT country, COUNT(*) FROM pancakes GROUP BY country ON CONFLICT (country) DO UPDATE SET latest_serial = EXCLUDED.latest_serial");
await db.query("INSERT INTO world_state (world_id, latest_global_serial, committed_serial, height_meters, height_units, latest_chunk_id, current_drop_id, version) VALUES ($1, $2::bigint, $2::bigint, $3, $4, $5, NULL, 1) ON CONFLICT (world_id) DO UPDATE SET latest_global_serial = EXCLUDED.latest_global_serial, committed_serial = EXCLUDED.committed_serial, height_meters = EXCLUDED.height_meters, height_units = EXCLUDED.height_units, latest_chunk_id = EXCLUDED.latest_chunk_id, current_drop_id = NULL, version = 1", [cfg.worldId, count, heightMeters, heightUnits, nChunks - 1]);
const dbSize = (await db.query<{ s: string }>("SELECT pg_size_pretty(pg_database_size(current_database())) AS s")).rows[0].s;
console.log(`pancake rows ${((performance.now() - tp) / 1000).toFixed(1)} s`);
console.log(`done: ${count} pancakes, ${nChunks} chunks, ${(bytesTotal / 1e6).toFixed(1)} MB chunk bytes, height ${heightMeters.toFixed(1)} m, db ${dbSize}, ${((performance.now() - t0) / 1000).toFixed(1)} s total`);
await db.close();
