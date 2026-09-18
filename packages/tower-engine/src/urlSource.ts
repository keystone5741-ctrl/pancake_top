import type { ChunkId } from "pancake-core";
import { decodeChunk, type TowerManifest } from "./binaryChunk";
import type { ChunkHeader, TowerChunk } from "./chunk";
import type { TowerConfig } from "./config";
import type { ChunkSource } from "./source";

/** manifest + chunk 파일 URL 로 스트리밍하는 소스 (CDN 형태). fetch 는 주입 가능 (테스트용). */
export class UrlChunkSource implements ChunkSource {
  readonly config: TowerConfig;
  readonly headers: readonly ChunkHeader[];
  readonly totalCount: number;
  private readonly cache = new Map<ChunkId, TowerChunk>();
  constructor(manifest: TowerManifest, private readonly urlFor: (id: ChunkId) => string, private readonly fetchImpl: (url: string) => Promise<ArrayBuffer> = (u) => fetch(u).then((r) => { if (!r.ok) throw new Error(`${u}: ${r.status}`); return r.arrayBuffer(); })) {
    this.config = manifest.config;
    this.headers = manifest.headers;
    this.totalCount = manifest.totalCount;
  }
  async load(id: ChunkId): Promise<TowerChunk> {
    const c = this.cache.get(id);
    if (c) return c;
    const { chunk } = decodeChunk(await this.fetchImpl(this.urlFor(id)));
    this.cache.set(id, chunk);
    return chunk;
  }
  peek(id: ChunkId): TowerChunk | undefined { return this.cache.get(id); }
}
