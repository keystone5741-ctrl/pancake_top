import { mkdir, readFile, rename, writeFile, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";

/** Chunk 바이너리 저장소 (Phase 2 §16). 로컬 파일 → 향후 S3 / R2. 파일은 DB 의 chunks.data 에서 파생된 서빙 복사본이다. */
export interface ChunkStorage {
  put(chunkId: number, data: Uint8Array): Promise<void>;
  get(chunkId: number): Promise<Uint8Array | null>;
  list(): Promise<number[]>;
  remove(chunkId: number): Promise<void>;
}

export const chunkFileName = (id: number): string => `${String(id).padStart(6, "0")}.chunk`;

export class LocalChunkStorage implements ChunkStorage {
  constructor(readonly dir: string) {}
  private path(id: number): string { return join(this.dir, chunkFileName(id)); }
  async put(chunkId: number, data: Uint8Array): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const tmp = this.path(chunkId) + ".tmp";
    await writeFile(tmp, data);
    await rename(tmp, this.path(chunkId)); // atomic replace
  }
  async get(chunkId: number): Promise<Uint8Array | null> {
    try { return new Uint8Array(await readFile(this.path(chunkId))); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
  }
  async list(): Promise<number[]> {
    try { return (await readdir(this.dir)).filter((f) => f.endsWith(".chunk")).map((f) => Number(f.slice(0, 6))).sort((a, b) => a - b); } catch { return []; }
  }
  async remove(chunkId: number): Promise<void> { try { await unlink(this.path(chunkId)); } catch { /* ignore */ } }
}

/** 테스트용 메모리 저장소 */
export class MemoryChunkStorage implements ChunkStorage {
  readonly files = new Map<number, Uint8Array>();
  failNextPut = false;
  async put(chunkId: number, data: Uint8Array): Promise<void> { if (this.failNextPut) { this.failNextPut = false; throw new Error("injected storage failure"); } this.files.set(chunkId, data); }
  async get(chunkId: number): Promise<Uint8Array | null> { return this.files.get(chunkId) ?? null; }
  async list(): Promise<number[]> { return [...this.files.keys()].sort((a, b) => a - b); }
  async remove(chunkId: number): Promise<void> { this.files.delete(chunkId); }
}
