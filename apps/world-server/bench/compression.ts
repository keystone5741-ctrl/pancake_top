/**
 * .chunk 압축 비교 (Phase 3A §13): raw / gzip / brotli — 100k / 500k / 1M 합성 데이터.
 *   pnpm --filter world-server bench:compression -- [--counts 100000,500000,1000000] [--out ../../docs/benchmarks/phase3a-compression.json]
 * 측정: 크기, 압축 CPU, 해제 CPU (Node), 브라우저 fetch+decode 시간은 world-prototype bench/compression.ts (Chromium) 에서.
 */
import { brotliCompressSync, brotliDecompressSync, constants, gzipSync, gunzipSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { DEFAULT_TOWER_CONFIG, buildChunk, encodeChunk, generateSyntheticTower } from "tower-engine";

const argv = process.argv.slice(2);
const opt = (k: string, d: string): string => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const counts = opt("--counts", "100000,500000,1000000").split(",").map(Number);
const out = opt("--out", "");
const cfg = { ...DEFAULT_TOWER_CONFIG, chunkSize: 10_000 };
const results = [];
for (const n of counts) {
  const set = generateSyntheticTower(n, cfg, 42);
  const chunks: Uint8Array[] = [];
  for (let id = 0; id * cfg.chunkSize < n; id++) chunks.push(new Uint8Array(encodeChunk(buildChunk(set, id, id * cfg.chunkSize, Math.min(n, (id + 1) * cfg.chunkSize), cfg), cfg)));
  const raw = chunks.reduce((a, c) => a + c.byteLength, 0);
  const row: Record<string, unknown> = { count: n, chunks: chunks.length, rawBytes: raw };
  for (const [name, comp, decomp] of [
    ["gzip6", (b: Uint8Array) => gzipSync(b, { level: 6 }), gunzipSync],
    ["gzip9", (b: Uint8Array) => gzipSync(b, { level: 9 }), gunzipSync],
    ["brotli4", (b: Uint8Array) => brotliCompressSync(b, { params: { [constants.BROTLI_PARAM_QUALITY]: 4 } }), brotliDecompressSync],
    ["brotli9", (b: Uint8Array) => brotliCompressSync(b, { params: { [constants.BROTLI_PARAM_QUALITY]: 9 } }), brotliDecompressSync],
  ] as const) {
    const t0 = performance.now(); const packed = chunks.map((c) => comp(c)); const cms = performance.now() - t0;
    const t1 = performance.now(); for (const p of packed) decomp(p); const dms = performance.now() - t1;
    const bytes = packed.reduce((a, c) => a + c.byteLength, 0);
    row[name] = { bytes, ratio: bytes / raw, compressMs: cms, decompressMs: dms, compressMsPerChunk: cms / chunks.length, decompressMsPerChunk: dms / chunks.length };
  }
  results.push(row);
  const f = (k: string): string => { const r = row[k] as { ratio: number; compressMs: number; decompressMs: number }; return `${k} ${(r.ratio * 100).toFixed(1)}% (c ${r.compressMs.toFixed(0)} ms, d ${r.decompressMs.toFixed(0)} ms)`; };
  console.log(`${n}: raw ${(raw / 1048576).toFixed(1)} MB | ${["gzip6", "gzip9", "brotli4", "brotli9"].map(f).join(" | ")}`);
}
if (out) { writeFileSync(out, JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2)); console.log(`wrote ${out}`); }
