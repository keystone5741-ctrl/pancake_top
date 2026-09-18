import type { ChunkId } from "pancake-core";
import { decodeChunk, type TowerManifest } from "./binaryChunk";
import type { ChunkHeader, TowerChunk } from "./chunk";
import type { TowerConfig } from "./config";
import type { ChunkSource } from "./source";

export type Hasher = (bytes: ArrayBuffer) => Promise<string>;

/** 브라우저/Node 공용 SHA-256 (hex) — crypto.subtle */
export const sha256Hex: Hasher = async (bytes) => {
  const d = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, "0")).join("");
};

export class ChunkChecksumError extends Error { constructor(readonly chunkId: ChunkId, readonly expected: string, readonly actual: string) { super(`chunk ${chunkId} checksum mismatch`); } }

/**
 * manifest + chunk 파일 URL 로 스트리밍하는 소스 (CDN 형태, Phase 2 §19, §42).
 * 메모리 캐시: 같은 chunk 를 다시 받지 않는다. manifest 가 갱신되면 checksum 이 바뀐 chunk 만 캐시에서 버린다.
 * checksum 이 있으면 SHA-256 으로 검증하고 불일치 시 ChunkChecksumError (손상 감지, §38).
 */
export class UrlChunkSource implements ChunkSource {
  config: TowerConfig;
  headers: ChunkHeader[];
  totalCount: number;
  version: number | string | undefined;
  private readonly cache = new Map<ChunkId, TowerChunk>();
  private readonly inflight = new Map<ChunkId, Promise<TowerChunk>>();
  readonly stats = { fetches: 0, bytes: 0, cacheHits: 0, checksumFailures: 0 };
  constructor(manifest: TowerManifest & { version?: number | string }, private readonly urlFor: (id: ChunkId) => string, private readonly fetchImpl: (url: string) => Promise<ArrayBuffer> = (u) => fetch(u).then((r) => { if (!r.ok) throw new Error(`${u}: ${r.status}`); return r.arrayBuffer(); }), private readonly hasher: Hasher | null = typeof crypto !== "undefined" && crypto.subtle ? sha256Hex : null) {
    this.config = manifest.config;
    this.headers = manifest.headers.map((h) => ({ ...h }));
    this.totalCount = manifest.totalCount;
    this.version = manifest.version;
  }
  /** 새 manifest 적용. 반환: 내용이 바뀐(checksum 다름) 또는 새로 생긴 chunk id. 바뀐 것은 캐시에서 제거. */
  updateManifest(manifest: TowerManifest & { version?: number | string }): ChunkId[] {
    const prev = new Map(this.headers.map((h) => [h.id, h]));
    const changed: ChunkId[] = [];
    for (const h of manifest.headers) {
      const p = prev.get(h.id);
      if (!p || p.checksum !== h.checksum || p.count !== h.count) { changed.push(h.id); this.cache.delete(h.id); this.inflight.delete(h.id); }
    }
    this.headers = manifest.headers.map((h) => ({ ...h }));
    this.totalCount = manifest.totalCount;
    this.config = manifest.config;
    this.version = manifest.version;
    return changed;
  }
  async load(id: ChunkId): Promise<TowerChunk> {
    const c = this.cache.get(id);
    if (c) { this.stats.cacheHits++; return c; }
    const f = this.inflight.get(id);
    if (f) return f;
    const p = (async () => {
      const header = this.headers.find((h) => h.id === id);
      let buf = await this.fetchImpl(this.urlFor(id));
      this.stats.fetches++; this.stats.bytes += buf.byteLength;
      if (header?.checksum && this.hasher) {
        const actual = await this.hasher(buf);
        if (actual !== header.checksum) {
          this.stats.checksumFailures++;
          // 한 번 재시도 (캐시된 손상 응답 회피)
          buf = await this.fetchImpl(this.urlFor(id) + (this.urlFor(id).includes("?") ? "&" : "?") + "retry=1");
          this.stats.fetches++; this.stats.bytes += buf.byteLength;
          const again = await this.hasher(buf);
          if (again !== header.checksum) throw new ChunkChecksumError(id, header.checksum, again);
        }
      }
      const { chunk } = decodeChunk(buf);
      if (header?.checksum) chunk.checksum = header.checksum;
      this.cache.set(id, chunk);
      this.inflight.delete(id);
      return chunk;
    })();
    this.inflight.set(id, p);
    return p;
  }
  peek(id: ChunkId): TowerChunk | undefined { return this.cache.get(id); }
  get cachedChunkIds(): ChunkId[] { return [...this.cache.keys()]; }
}
