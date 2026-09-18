import type { ChunkId, PancakeTransformSet } from "pancake-core";
import { buildChunk, headerOf, type ChunkHeader, type TowerChunk } from "./chunk";
import type { TowerConfig } from "./config";

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
