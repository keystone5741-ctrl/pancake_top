import { createHash } from "node:crypto";
import { decodeTower, encodeTower, type TowerData } from "pancake-physics";
import { emptyTransformSet, encodeCountry, worldUnitsToMeters, type PancakeTransformSet } from "pancake-core";
import { DEFAULT_TOWER_CONFIG, buildChunk, decodeChunk, encodeChunk, type TowerChunk, type TowerConfig } from "tower-engine";
import type { ServerConfig } from "../config";
import type { Db, Queryable } from "../db/db";
import type { ChunkStorage } from "./chunkStorage";

export interface WorldStateRow { world_id: string; latest_global_serial: number; committed_serial: number; height_meters: number; height_units: number; latest_chunk_id: number; current_drop_id: string | null; version: number; updated_at: Date }
export interface ChunkRow { chunk_id: number; start_serial: number; end_serial: number; count: number; min_height: number; max_height: number; checksum: string; byte_length: number; finalized: boolean; version: number; bounds: { min: [number, number, number]; max: [number, number, number] } | null }

export interface ManifestChunk { id: number; startSerial: number; endSerial: number; count: number; minHeight: number; maxHeight: number; bounds: { min: [number, number, number]; max: [number, number, number] }; checksum: string; byteLength: number; finalized: boolean; url: string }
export interface Manifest { version: number; totalPancakes: number; allocatedPancakes: number; heightMeters: number; heightUnits: number; chunkSize: number; diameter: number; thickness: number; unitCm: number; chunks: ManifestChunk[] }

export interface CommitInput { jobId: string; dropId: string; startSerial: number; endSerial: number; finalTransforms: TowerData; heightUnits: number; countries: Uint16Array }

export const sha256 = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");

/**
 * World persistence (Phase 2 §12, §16~§20, §34~§37).
 * DB 의 chunks.data 가 authoritative, 파일 저장소는 서빙용 복사본. 커밋 순서:
 *   simulation 결과 → chunk 인코딩·파일 쓰기 → DB 트랜잭션(chunk 행+bytes, pancakes.committed_at, world_state.version+1, job DONE) → 이벤트.
 * 트랜잭션 전에 실패하면 이전 version 이 authoritative 이고 파일은 startup 에서 DB 로 되돌린다.
 */
export class WorldStore {
  readonly towerConfig: TowerConfig;
  private state!: WorldStateRow;
  /** 현재 mutable chunk 의 내용 (마지막 chunk). finalized 되면 새 set 을 시작한다. */
  private current: PancakeTransformSet | null = null;
  private currentId = -1;
  metrics = { chunkWriteMs: 0, chunkWrites: 0, commitMs: 0, commits: 0, manifestMs: 0, snapshots: 0, recoveredFiles: 0 };
  /** commit / refresh / snapshot 직렬화. refresh 가 커밋 도중 끼어들면 stale 한 world_state·current chunk 로 덮어써 다음 커밋이 어긋난다 (batch 벤치에서 실제 발생). */
  private lock: Promise<unknown> = Promise.resolve();
  private serialized<T>(fn: () => Promise<T>): Promise<T> { const run = this.lock.then(fn, fn); this.lock = run.catch(() => undefined); return run; }

  constructor(readonly db: Db, readonly storage: ChunkStorage, readonly cfg: ServerConfig) {
    this.towerConfig = { ...DEFAULT_TOWER_CONFIG, chunkSize: cfg.chunkSize };
  }

  get worldState(): WorldStateRow { return this.state; }
  get version(): number { return this.state.version; }
  get committedSerial(): number { return this.state.committed_serial; }

  // ---------------------------------------------------------------- startup / recovery
  async load(): Promise<void> {
    await this.db.query("INSERT INTO world_state (world_id) VALUES ($1) ON CONFLICT (world_id) DO NOTHING", [this.cfg.worldId]);
    this.state = (await this.db.query<WorldStateRow>("SELECT * FROM world_state WHERE world_id = $1", [this.cfg.worldId])).rows[0];
    await this.reconcileChunkFiles();
    await this.loadCurrentChunk();
  }

  /** 파일 저장소를 DB 와 일치시킨다 (§37: chunk 저장 후 DB 커밋 전 crash 등). */
  private async reconcileChunkFiles(): Promise<void> {
    const rows = (await this.db.query<ChunkRow & { data: Buffer }>("SELECT chunk_id, checksum, data FROM chunks ORDER BY chunk_id")).rows;
    const known = new Set<number>();
    for (const r of rows) {
      known.add(r.chunk_id);
      const file = await this.storage.get(r.chunk_id);
      if (!file || sha256(file) !== r.checksum) { await this.storage.put(r.chunk_id, new Uint8Array(r.data)); this.metrics.recoveredFiles++; }
    }
    // DB 에 없는 파일(커밋 전 crash 로 남은 것)은 제거
    for (const id of await this.storage.list()) if (!known.has(id)) { await this.storage.remove(id); this.metrics.recoveredFiles++; }
  }

  private async loadCurrentChunk(): Promise<void> {
    const id = this.state.latest_chunk_id;
    if (id < 0) { this.current = null; this.currentId = -1; return; }
    const row = (await this.db.query<{ data: Buffer; finalized: boolean }>("SELECT data, finalized FROM chunks WHERE chunk_id = $1", [id])).rows[0];
    const { chunk } = decodeChunk(bufToArrayBuffer(row.data));
    if (row.finalized) { this.current = null; this.currentId = id; return; }
    this.current = chunkToSet(chunk, this.towerConfig);
    this.currentId = id;
  }

  // ---------------------------------------------------------------- surface for the worker
  /** 상위 K 장 (PKT1). worker INIT 용. 마지막 chunk 들에서 뽑는다. */
  async surfaceSlice(k = this.cfg.surfaceSliceSize): Promise<Uint8Array | null> {
    if (this.state.committed_serial === 0) return null;
    const sets: PancakeTransformSet[] = [];
    let id = this.state.latest_chunk_id;
    let n = 0;
    while (id >= 0 && n < k) {
      const row = (await this.db.query<{ data: Buffer }>("SELECT data FROM chunks WHERE chunk_id = $1", [id])).rows[0];
      if (!row) break;
      const set = chunkToSet(decodeChunk(bufToArrayBuffer(row.data)).chunk, this.towerConfig);
      sets.unshift(set); n += set.count; id--;
    }
    const all = concat(sets, this.towerConfig);
    return new Uint8Array(encodeTower(topK(all, k)));
  }

  // ---------------------------------------------------------------- commit
  commit(input: CommitInput): Promise<{ version: number; chunkIds: number[] }> { return this.serialized(() => this.commitLocked(input)); }
  private async commitLocked(input: CommitInput): Promise<{ version: number; chunkIds: number[] }> {
    const t0 = performance.now();
    if (input.startSerial !== this.state.committed_serial + 1) throw new Error(`commit out of order: expected ${this.state.committed_serial + 1}, got ${input.startSerial}`);
    const cs = this.towerConfig.chunkSize;
    const t = input.finalTransforms;
    // 1) mutable chunk 에 이어 붙이고, 가득 차면 finalize, 남으면 새 chunk
    const touched: { id: number; set: PancakeTransformSet; finalized: boolean }[] = [];
    let offset = 0;
    while (offset < t.count) {
      if (!this.current) { this.currentId = this.currentId + 1; this.current = emptyTransformSet(0, t.diameter, t.thickness, t.unitCm, this.currentId * cs); this.current.variant = new Uint16Array(0); this.current.country = new Uint16Array(0); }
      const room = cs - this.current.count;
      const take = Math.min(room, t.count - offset);
      this.current = appendSlice(this.current, t, offset, take, input.countries.subarray(offset, offset + take));
      offset += take;
      const finalized = this.current.count === cs;
      touched.push({ id: this.currentId, set: this.current, finalized });
      if (finalized) this.current = null;
    }
    // 2) encode + 파일 쓰기
    const encoded: { id: number; bytes: Uint8Array; chunk: TowerChunk; checksum: string; finalized: boolean }[] = [];
    const tw = performance.now();
    for (const x of touched) {
      const chunk = buildChunk(x.set, x.id, 0, x.set.count, this.towerConfig);
      const bytes = new Uint8Array(encodeChunk(chunk, this.towerConfig));
      const checksum = sha256(bytes);
      await this.storage.put(x.id, bytes);
      encoded.push({ id: x.id, bytes, chunk, checksum, finalized: x.finalized });
    }
    this.metrics.chunkWriteMs += performance.now() - tw; this.metrics.chunkWrites += encoded.length;
    // 3) DB 트랜잭션 (version+1)
    const newVersion = this.state.version + 1;
    const heightUnits = Math.max(this.state.height_units, input.heightUnits);
    const heightMeters = worldUnitsToMeters(heightUnits, this.towerConfig.unitCm);
    const latestChunk = encoded[encoded.length - 1].id;
    await this.db.tx(async (c) => {
      // 락 순서: purchase 트랜잭션(serial.ts)과 같이 world_state 행을 먼저 잡는다. 안 그러면
      // purchase(world_state → drops) 와 commit(drops → world_state) 이 교착한다 (batch 벤치에서 실제 발생).
      const cur = await c.query<{ version: number }>("SELECT version FROM world_state WHERE world_id = $1 FOR UPDATE", [this.cfg.worldId]);
      if (!cur.rows.length || cur.rows[0].version !== this.state.version) throw new Error("world version conflict");
      for (const e of encoded) {
        await c.query(
          `INSERT INTO chunks (chunk_id, start_serial, end_serial, count, min_height, max_height, checksum, byte_length, finalized, version, data, bounds, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, now())
           ON CONFLICT (chunk_id) DO UPDATE SET start_serial = EXCLUDED.start_serial, end_serial = EXCLUDED.end_serial, count = EXCLUDED.count, min_height = EXCLUDED.min_height, max_height = EXCLUDED.max_height, checksum = EXCLUDED.checksum, byte_length = EXCLUDED.byte_length, finalized = EXCLUDED.finalized, version = EXCLUDED.version, data = EXCLUDED.data, bounds = EXCLUDED.bounds, updated_at = now()`,
          [e.id, e.chunk.startSerial + 1, e.chunk.endSerial + 1, e.chunk.count, e.chunk.minHeight, e.chunk.maxHeight, e.checksum, e.bytes.byteLength, e.finalized, newVersion, Buffer.from(e.bytes), JSON.stringify(e.chunk.bounds)],
        );
      }
      await c.query("UPDATE pancakes SET committed_at = now() WHERE global_serial BETWEEN $1 AND $2", [input.startSerial, input.endSerial]);
      await c.query("UPDATE drops SET height_after = $2, simulation_started_at = COALESCE(simulation_started_at, now()) WHERE drop_id = $1", [input.dropId, heightMeters]);
      await c.query("UPDATE simulation_jobs SET status = 'DONE', finished_at = now() WHERE job_id = $1", [input.jobId]);
      const upd = await c.query<WorldStateRow>(
        "UPDATE world_state SET committed_serial = $2, height_units = $3, height_meters = $4, latest_chunk_id = $5, version = $6, updated_at = now() WHERE world_id = $1 AND version = $7 RETURNING *",
        [this.cfg.worldId, input.endSerial, heightUnits, heightMeters, latestChunk, newVersion, this.state.version],
      );
      if (!upd.rows.length) throw new Error("world version conflict");
      this.state = upd.rows[0];
    });
    this.metrics.commitMs += performance.now() - t0; this.metrics.commits++;
    return { version: newVersion, chunkIds: encoded.map((e) => e.id) };
  }

  /** 테스트/복구용: DB 상태를 다시 읽는다 */
  refresh(): Promise<void> { return this.serialized(async () => { this.state = (await this.db.query<WorldStateRow>("SELECT * FROM world_state WHERE world_id = $1", [this.cfg.worldId])).rows[0]; await this.loadCurrentChunk(); }); }

  // ---------------------------------------------------------------- manifest
  async manifest(baseUrl = ""): Promise<Manifest> {
    const t0 = performance.now();
    const rows = (await this.db.query<ChunkRow>("SELECT chunk_id, start_serial, end_serial, count, min_height, max_height, checksum, byte_length, finalized, version, bounds FROM chunks ORDER BY chunk_id")).rows;
    const m: Manifest = {
      version: this.state.version, totalPancakes: this.state.committed_serial, allocatedPancakes: this.state.latest_global_serial,
      heightMeters: this.state.height_meters, heightUnits: this.state.height_units, chunkSize: this.towerConfig.chunkSize,
      diameter: this.towerConfig.diameter, thickness: this.towerConfig.thickness, unitCm: this.towerConfig.unitCm,
      chunks: rows.map((r) => ({ id: r.chunk_id, startSerial: r.start_serial, endSerial: r.end_serial, count: r.count, minHeight: r.min_height, maxHeight: r.max_height, bounds: r.bounds ?? { min: [-1, r.min_height, -1], max: [1, r.max_height, 1] }, checksum: r.checksum, byteLength: r.byte_length, finalized: r.finalized, url: `${baseUrl}/api/world/chunks/${r.chunk_id}?c=${r.checksum.slice(0, 16)}` })),
    };
    this.metrics.manifestMs = performance.now() - t0;
    return m;
  }

  async chunkBytes(chunkId: number): Promise<{ data: Uint8Array; checksum: string; finalized: boolean } | null> {
    const row = (await this.db.query<{ data: Buffer; checksum: string; finalized: boolean }>("SELECT data, checksum, finalized FROM chunks WHERE chunk_id = $1", [chunkId])).rows[0];
    return row ? { data: new Uint8Array(row.data), checksum: row.checksum, finalized: row.finalized } : null;
  }

  // ---------------------------------------------------------------- snapshot (§34, §35)
  snapshot(): Promise<number> { return this.serialized(() => this.snapshotLocked()); }
  private async snapshotLocked(): Promise<number> {
    const surface = (await this.surfaceSlice()) ?? new Uint8Array(0);
    const lastCompleted = this.current ? this.currentId - 1 : this.currentId;
    const r = await this.db.query<{ snapshot_id: number }>(
      "INSERT INTO world_snapshots (version, latest_serial, height_meters, surface_state, last_completed_chunk, current_chunk) VALUES ($1,$2,$3,$4,$5,$6) RETURNING snapshot_id",
      [this.state.version, this.state.committed_serial, this.state.height_meters, Buffer.from(surface), lastCompleted, this.currentId],
    );
    this.metrics.snapshots++;
    return r.rows[0].snapshot_id;
  }

  /** 서버 시작 시 미완 job 정리 (§23, §25): RUNNING → RETRYABLE */
  async recoverJobs(q: Queryable = this.db): Promise<number> {
    const r = await q.query("UPDATE simulation_jobs SET status = 'RETRYABLE', error = COALESCE(error, 'server restarted') WHERE status = 'RUNNING'");
    return r.rowCount ?? 0;
  }
}

// ---------------------------------------------------------------- helpers
function bufToArrayBuffer(b: Buffer): ArrayBuffer { return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer; }

export function chunkToSet(c: TowerChunk, cfg: TowerConfig): PancakeTransformSet {
  const n = c.count;
  const s = emptyTransformSet(n, cfg.diameter, cfg.thickness, cfg.unitCm, c.startSerial);
  s.variant = new Uint16Array(n); s.country = new Uint16Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * 9;
    s.px[i] = c.transforms[o]; s.py[i] = c.transforms[o + 1]; s.pz[i] = c.transforms[o + 2];
    s.qx[i] = c.transforms[o + 3]; s.qy[i] = c.transforms[o + 4]; s.qz[i] = c.transforms[o + 5]; s.qw[i] = c.transforms[o + 6];
    s.scale[i] = c.transforms[o + 7]; s.tscale[i] = c.transforms[o + 8];
    s.variant[i] = c.attributes.variant[i]; s.country[i] = c.attributes.country[i];
  }
  return s;
}

function appendSlice(base: PancakeTransformSet, t: TowerData, from: number, take: number, countries: Uint16Array): PancakeTransformSet {
  const n = base.count + take;
  const cat = (a: Float32Array, b: Float32Array): Float32Array => { const o = new Float32Array(n); o.set(a.subarray(0, base.count)); o.set(b.subarray(from, from + take), base.count); return o; };
  const variant = new Uint16Array(n); variant.set(base.variant ?? new Uint16Array(base.count));
  const country = new Uint16Array(n).fill(675); country.set(base.country ?? new Uint16Array(base.count).fill(675)); country.set(countries, base.count);
  return { count: n, startSerial: base.startSerial, diameter: base.diameter, thickness: base.thickness, unitCm: base.unitCm, px: cat(base.px, t.px), py: cat(base.py, t.py), pz: cat(base.pz, t.pz), qx: cat(base.qx, t.qx), qy: cat(base.qy, t.qy), qz: cat(base.qz, t.qz), qw: cat(base.qw, t.qw), scale: cat(base.scale, t.scale), tscale: cat(base.tscale, t.tscale), variant, country };
}

function concat(sets: PancakeTransformSet[], cfg: TowerConfig): PancakeTransformSet {
  const n = sets.reduce((a, s) => a + s.count, 0);
  const out = emptyTransformSet(n, cfg.diameter, cfg.thickness, cfg.unitCm, sets[0]?.startSerial ?? 0);
  let o = 0;
  for (const s of sets) { for (const k of ["px", "py", "pz", "qx", "qy", "qz", "qw", "scale", "tscale"] as const) out[k].set(s[k].subarray(0, s.count), o); o += s.count; }
  return out;
}

/** y 기준 상위 k 장 (원래 순서 유지) */
export function topK(t: PancakeTransformSet, k: number): TowerData {
  const idx = Array.from({ length: t.count }, (_, i) => i).sort((a, b) => t.py[b] - t.py[a]).slice(0, Math.min(k, t.count)).sort((a, b) => a - b);
  const m = idx.length;
  const pick = (arr: Float32Array): Float32Array => { const o = new Float32Array(m); for (let i = 0; i < m; i++) o[i] = arr[idx[i]]; return o; };
  return { count: m, diameter: t.diameter, thickness: t.thickness, unitCm: t.unitCm, px: pick(t.px), py: pick(t.py), pz: pick(t.pz), qx: pick(t.qx), qy: pick(t.qy), qz: pick(t.qz), qw: pick(t.qw), scale: pick(t.scale), tscale: pick(t.tscale) };
}

export { decodeTower, encodeCountry };
