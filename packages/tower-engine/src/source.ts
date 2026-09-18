import type { ChunkId, PancakeTransformSet } from "pancake-core";
import { buildChunk, headerOf, type ChunkHeader, type TowerChunk } from "./chunk";
import { TRANSFORM_STRIDE, type TowerConfig } from "./config";

/** chunk → PancakeTransformSet (append 시 마지막 부분 chunk 재구성용) */
export function chunkToTransformSet(c: TowerChunk, cfg: TowerConfig): PancakeTransformSet {
  const n = c.count;
  const mk = (): Float32Array => new Float32Array(n);
  const s: PancakeTransformSet = { count: n, startSerial: c.startSerial, diameter: cfg.diameter, thickness: cfg.thickness, unitCm: cfg.unitCm, px: mk(), py: mk(), pz: mk(), qx: mk(), qy: mk(), qz: mk(), qw: mk(), scale: mk(), tscale: mk(), variant: new Uint16Array(n), country: new Uint16Array(n) };
  for (let i = 0; i < n; i++) {
    const o = i * TRANSFORM_STRIDE;
    s.px[i] = c.transforms[o]; s.py[i] = c.transforms[o + 1]; s.pz[i] = c.transforms[o + 2];
    s.qx[i] = c.transforms[o + 3]; s.qy[i] = c.transforms[o + 4]; s.qz[i] = c.transforms[o + 5]; s.qw[i] = c.transforms[o + 6];
    s.scale[i] = c.transforms[o + 7]; s.tscale[i] = c.transforms[o + 8];
    s.variant![i] = c.attributes.variant[i]; s.country![i] = c.attributes.country[i];
  }
  return s;
}

export function concatTransformSets(a: PancakeTransformSet, b: PancakeTransformSet): PancakeTransformSet {
  const n = a.count + b.count;
  const cat = (x: Float32Array, y: Float32Array): Float32Array => { const o = new Float32Array(n); o.set(x.subarray(0, a.count)); o.set(y.subarray(0, b.count), a.count); return o; };
  const cat16 = (x: Uint16Array | undefined, y: Uint16Array | undefined, fill: number): Uint16Array => { const o = new Uint16Array(n).fill(fill); if (x) o.set(x.subarray(0, a.count)); if (y) o.set(y.subarray(0, b.count), a.count); return o; };
  return { count: n, startSerial: a.startSerial ?? 0, diameter: a.diameter, thickness: a.thickness, unitCm: a.unitCm, px: cat(a.px, b.px), py: cat(a.py, b.py), pz: cat(a.pz, b.pz), qx: cat(a.qx, b.qx), qy: cat(a.qy, b.qy), qz: cat(a.qz, b.qz), qw: cat(a.qw, b.qw), scale: cat(a.scale, b.scale), tscale: cat(a.tscale, b.tscale), variant: cat16(a.variant, b.variant, 0), country: cat16(a.country, b.country, 675) };
}

/**
 * Chunk 공급자. 지금은 메모리, 나중에는 네트워크/CDN (Phase 1 §5).
 * headers 는 시작 시 한 번에 알 수 있어야 한다 (높이·가시성·인덱스의 근거). transform 은 load 로 가져온다.
 */
export interface ChunkSource {
  readonly config: TowerConfig;
  readonly headers: readonly ChunkHeader[];
  readonly totalCount: number;
  load(id: ChunkId): Promise<TowerChunk>;
  /** 동기적으로 바로 줄 수 있으면 반환 (메모리 소스). 아니면 undefined. */
  peek?(id: ChunkId): TowerChunk | undefined;
}

/** 메모리에 있는 PancakeTransformSet 을 chunk 로 잘라 제공한다 */
export class MemoryChunkSource implements ChunkSource {
  readonly config: TowerConfig;
  readonly headers: ChunkHeader[];
  readonly totalCount: number;
  private readonly chunks: TowerChunk[];

  constructor(set: PancakeTransformSet, config: TowerConfig) {
    this.config = config;
    this.totalCount = set.count;
    this.chunks = [];
    const first = set.startSerial ?? 0;
    if (first % config.chunkSize !== 0) throw new Error("startSerial must be aligned to chunkSize");
    for (let from = 0; from < set.count; from += config.chunkSize) {
      const to = Math.min(set.count, from + config.chunkSize);
      const id = (first + from) / config.chunkSize;
      this.chunks.push(buildChunk(set, id, from, to, config));
    }
    this.headers = this.chunks.map(headerOf);
  }
  load(id: ChunkId): Promise<TowerChunk> {
    const c = this.peek(id);
    return c ? Promise.resolve(c) : Promise.reject(new Error(`no chunk ${id}`));
  }
  peek(id: ChunkId): TowerChunk | undefined {
    return this.chunks.find((c) => c.id === id);
  }

  /**
   * 새 Drop 결과를 뒤에 붙인다 (Phase 1 §18 continuous). 마지막 부분 chunk 는 다시 만들고 나머지는 새 chunk.
   * 반환: 내용이 바뀌거나 새로 생긴 chunk id 목록 (렌더러가 GPU 표현을 갱신해야 함).
   */
  append(set: PancakeTransformSet): ChunkId[] {
    const cs = this.config.chunkSize;
    const changed: ChunkId[] = [];
    let pending = set;
    const last = this.chunks[this.chunks.length - 1];
    if (last && last.count < cs) {
      const merged = concatTransformSets(chunkToTransformSet(last, this.config), pending);
      const take = Math.min(cs, merged.count);
      this.chunks[this.chunks.length - 1] = buildChunk(merged, last.id, 0, take, this.config);
      changed.push(last.id);
      pending = sliceSet(merged, take);
    }
    let from = 0;
    while (from < pending.count) {
      const to = Math.min(pending.count, from + cs);
      const id = this.chunks.length ? this.chunks[this.chunks.length - 1].id + 1 : 0;
      this.chunks.push(buildChunk(pending, id, from, to, this.config));
      changed.push(id);
      from = to;
    }
    this.headers.length = 0;
    for (const c of this.chunks) this.headers.push(headerOf(c));
    (this as { totalCount: number }).totalCount = this.chunks.reduce((a, c) => a + c.count, 0);
    return changed;
  }
}

function sliceSet(t: PancakeTransformSet, from: number): PancakeTransformSet {
  const n = t.count - from;
  return { count: n, startSerial: (t.startSerial ?? 0) + from, diameter: t.diameter, thickness: t.thickness, unitCm: t.unitCm, px: t.px.slice(from), py: t.py.slice(from), pz: t.pz.slice(from), qx: t.qx.slice(from), qy: t.qy.slice(from), qz: t.qz.slice(from), qw: t.qw.slice(from), scale: t.scale.slice(from), tscale: t.tscale.slice(from), variant: t.variant?.slice(from), country: t.country?.slice(from) };
}

/** 이미 만들어진 chunk 목록(예: 파일에서 디코드)에서 제공 */
export class ChunkListSource implements ChunkSource {
  readonly headers: ChunkHeader[];
  readonly totalCount: number;
  constructor(readonly config: TowerConfig, private readonly chunks: TowerChunk[]) {
    this.headers = chunks.map(headerOf);
    this.totalCount = chunks.reduce((a, c) => a + c.count, 0);
  }
  load(id: ChunkId): Promise<TowerChunk> {
    const c = this.peek(id);
    return c ? Promise.resolve(c) : Promise.reject(new Error(`no chunk ${id}`));
  }
  peek(id: ChunkId): TowerChunk | undefined {
    return this.chunks.find((c) => c.id === id);
  }
}
