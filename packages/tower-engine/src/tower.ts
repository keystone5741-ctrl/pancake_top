import { worldUnitsToMeters, type ChunkId, type PancakeId, type PancakeMetadata, type PancakeTransform } from "pancake-core";
import { chunkIdOf, instanceIndexOf, readTransform, type ChunkHeader, type ChunkState, type TowerChunk } from "./chunk";
import type { TowerConfig } from "./config";
import type { ChunkSource } from "./source";
import { boundsIntersectsFrustum, type FrustumPlanes } from "./visibility";
import { decodeCountry } from "pancake-core";

export interface FindResult {
  pancakeId: PancakeId;
  chunkId: ChunkId;
  instanceIndex: number;
  transform: PancakeTransform;
  worldPosition: [number, number, number];
  metadata: PancakeMetadata;
}

/**
 * Tower Engine (플랜 §31). Chunk 관리, 인덱스, 높이, 가시 chunk 선택, Pancake lookup.
 * 렌더러와 물리에 의존하지 않는다. 높이의 source of truth 는 chunk header (서버 값).
 */
export class Tower {
  readonly config: TowerConfig;
  private readonly loaded = new Map<ChunkId, TowerChunk>();
  private readonly states = new Map<ChunkId, ChunkState>();
  private readonly headerById = new Map<ChunkId, ChunkHeader>();
  private readonly loading = new Map<ChunkId, Promise<TowerChunk>>();

  constructor(readonly source: ChunkSource) {
    this.config = source.config;
    for (const h of source.headers) { this.headerById.set(h.id, h); this.states.set(h.id, "UNLOADED"); }
  }

  get count(): number { return this.source.totalCount; }
  get chunkCount(): number { return this.source.headers.length; }
  get headers(): readonly ChunkHeader[] { return this.source.headers; }
  get loadedChunkCount(): number { return this.loaded.size; }

  /** 탑 높이 (world units) = 모든 chunk header 의 maxHeight 최대값. transform 로드 여부와 무관. */
  get height(): number {
    let h = 0;
    for (const c of this.source.headers) if (c.maxHeight > h) h = c.maxHeight;
    return h;
  }
  get heightMeters(): number { return worldUnitsToMeters(this.height, this.config.unitCm); }

  chunkIdOf(serial: PancakeId): ChunkId { return chunkIdOf(serial, this.config.chunkSize); }
  instanceIndexOf(serial: PancakeId): number { return instanceIndexOf(serial, this.config.chunkSize); }
  header(id: ChunkId): ChunkHeader | undefined { return this.headerById.get(id); }
  chunk(id: ChunkId): TowerChunk | undefined { return this.loaded.get(id); }
  state(id: ChunkId): ChunkState { return this.states.get(id) ?? "UNLOADED"; }

  /** 렌더러가 GPU 상태를 보고한다. CPU_READY 이하로 내리면 transform 은 유지하되 GPU 는 해제된 것으로 본다. */
  setState(id: ChunkId, state: ChunkState): void {
    if (!this.headerById.has(id)) return;
    if (state !== "UNLOADED" && !this.loaded.has(id)) throw new Error(`chunk ${id} not loaded`);
    this.states.set(id, state);
  }

  /** transform 을 메모리로 가져온다 (UNLOADED → CPU_READY). 이미 있으면 즉시. */
  async loadChunk(id: ChunkId): Promise<TowerChunk> {
    const have = this.loaded.get(id);
    if (have) return have;
    let p = this.loading.get(id);
    if (!p) {
      p = this.source.load(id).then((c) => { this.loaded.set(id, c); if (this.state(id) === "UNLOADED") this.states.set(id, "CPU_READY"); this.loading.delete(id); return c; });
      this.loading.set(id, p);
    }
    return p;
  }
  /** 메모리 소스면 동기 로드 */
  loadChunkSync(id: ChunkId): TowerChunk | undefined {
    const have = this.loaded.get(id);
    if (have) return have;
    const c = this.source.peek?.(id);
    if (c) { this.loaded.set(id, c); if (this.state(id) === "UNLOADED") this.states.set(id, "CPU_READY"); }
    return c;
  }
  unloadChunk(id: ChunkId): void { this.loaded.delete(id); this.states.set(id, "UNLOADED"); }

  /** 화면에 보이는 chunk (bounds 와 절두체 교차). O(chunk 수). */
  visibleChunkIds(frustum: FrustumPlanes): ChunkId[] {
    const out: ChunkId[] = [];
    for (const h of this.source.headers) if (boundsIntersectsFrustum(h.bounds, frustum)) out.push(h.id);
    return out;
  }

  /**
   * Find My Pancake (플랜 §35). id → chunk → instance 는 산술이므로 O(1).
   * chunk 가 CPU 에 없으면 null (findPancakeAsync 로 로드 후 조회).
   */
  findPancake(id: PancakeId): FindResult | null {
    if (!Number.isInteger(id) || id < 0 || id >= this.count) return null;
    const chunkId = this.chunkIdOf(id);
    const chunk = this.loaded.get(chunkId) ?? this.loadChunkSync(chunkId);
    if (!chunk) return null;
    return this.resultFrom(chunk, id);
  }
  async findPancakeAsync(id: PancakeId): Promise<FindResult | null> {
    if (!Number.isInteger(id) || id < 0 || id >= this.count) return null;
    const chunk = await this.loadChunk(this.chunkIdOf(id));
    return this.resultFrom(chunk, id);
  }

  private resultFrom(chunk: TowerChunk, id: PancakeId): FindResult {
    const instanceIndex = id - chunk.startSerial;
    const t = readTransform(chunk, instanceIndex);
    return {
      pancakeId: id, chunkId: chunk.id, instanceIndex, transform: t, worldPosition: t.position,
      metadata: {
        id, chunkId: chunk.id, instanceIndex, dropId: null,
        country: decodeCountry(chunk.attributes.country[instanceIndex]),
        variant: chunk.attributes.variant[instanceIndex],
        physicsState: "FROZEN",
      },
    };
  }
}
