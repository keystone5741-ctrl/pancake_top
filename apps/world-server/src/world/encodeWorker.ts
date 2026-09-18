/**
 * Chunk 인코딩 + SHA-256 을 worker_thread 에서 (Phase 3A §4-B: 물리 lane 과 겹치는 직렬화 작업).
 * main 스레드는 transform 배열을 넘기고 bytes/checksum 을 받는다. 스레드가 없으면 인라인으로 돈다.
 */
import { createHash } from "node:crypto";
import { Worker, isMainThread, parentPort } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import type { PancakeTransformSet } from "pancake-core";
import { buildChunk, encodeChunk, type TowerChunk, type TowerConfig } from "tower-engine";

export interface EncodeRequest { id: number; set: PancakeTransformSet; cfg: TowerConfig }
export interface EncodeResult { id: number; bytes: Uint8Array; checksum: string; chunk: TowerChunk }

export function encodeInline(req: EncodeRequest): EncodeResult {
  const chunk = buildChunk(req.set, req.id, 0, req.set.count, req.cfg);
  const bytes = new Uint8Array(encodeChunk(chunk, req.cfg));
  return { id: req.id, bytes, checksum: createHash("sha256").update(bytes).digest("hex"), chunk };
}

export class EncodeService {
  private worker: Worker | null = null;
  private seq = 0;
  private pending = new Map<number, { resolve: (r: EncodeResult) => void; reject: (e: Error) => void }>();
  metrics = { jobs: 0, msTotal: 0, threaded: 0 };
  constructor(readonly threaded = true) {}
  private ensure(): Worker {
    if (this.worker) return this.worker;
    // .ts 를 스레드에서 직접 로드하려면 tsx 로더를 그 스레드에 등록해야 한다 (execArgv --import 는 worker 에 적용되지 않는다)
    const entry = import.meta.url;
    const isTs = entry.endsWith(".ts");
    const w = isTs
      ? new Worker(`import("tsx/esm/api").then(({ register }) => { register(); return import(${JSON.stringify(entry)}); }).catch((e) => { throw e; });`, { eval: true })
      : new Worker(fileURLToPath(entry));
    w.on("message", (m: { seq: number; result?: EncodeResult; error?: string }) => { const p = this.pending.get(m.seq); if (!p) return; this.pending.delete(m.seq); if (m.error) p.reject(new Error(m.error)); else p.resolve(m.result!); });
    w.on("error", (e) => { for (const p of this.pending.values()) p.reject(e); this.pending.clear(); this.worker = null; });
    w.on("exit", () => { this.worker = null; });
    w.unref();
    this.worker = w;
    return w;
  }
  async encode(req: EncodeRequest): Promise<EncodeResult> {
    const t0 = performance.now();
    this.metrics.jobs++;
    try {
      if (!this.threaded) return encodeInline(req);
      const w = this.ensure();
      const seq = ++this.seq;
      this.metrics.threaded++;
      // chunk header 는 main 에서 다시 만들지 않도록 worker 가 함께 돌려준다 (구조화 복제)
      return await new Promise<EncodeResult>((resolve, reject) => { this.pending.set(seq, { resolve, reject }); w.postMessage({ seq, req }); });
    } finally { this.metrics.msTotal += performance.now() - t0; }
  }
  async stop(): Promise<void> { await this.worker?.terminate(); this.worker = null; }
}

if (!isMainThread && parentPort) {
  parentPort.on("message", (m: { seq: number; req: EncodeRequest }) => {
    try { parentPort!.postMessage({ seq: m.seq, result: encodeInline(m.req) }); } catch (e) { parentPort!.postMessage({ seq: m.seq, error: String(e) }); }
  });
}
