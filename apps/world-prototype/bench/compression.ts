/**
 * 브라우저 쪽 .chunk 압축 비교 (Phase 3A §13): raw / gzip / brotli 를 Content-Encoding 으로 서빙하고 fetch + arrayBuffer 시간을 잰다 (headless Chromium).
 *   tsx bench/compression.ts [--count 100000] [--out ../../docs/benchmarks/phase3a-compression-browser.json]
 */
import { chromium } from "playwright-core";
import { createServer } from "node:http";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { DEFAULT_TOWER_CONFIG, buildChunk, encodeChunk, generateSyntheticTower } from "tower-engine";

const argv = process.argv.slice(2);
const opt = (k: string, d: string): string => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const count = Number(opt("--count", "100000")); const out = opt("--out", "");
const cfg = { ...DEFAULT_TOWER_CONFIG, chunkSize: 10_000 };
const set = generateSyntheticTower(count, cfg, 42);
const chunks: Uint8Array[] = []; for (let id = 0; id * cfg.chunkSize < count; id++) chunks.push(new Uint8Array(encodeChunk(buildChunk(set, id, id * cfg.chunkSize, Math.min(count, (id + 1) * cfg.chunkSize), cfg), cfg)));
const enc = { raw: chunks, gzip: chunks.map((c) => gzipSync(c, { level: 6 })), br: chunks.map((c) => brotliCompressSync(c, { params: { [constants.BROTLI_PARAM_QUALITY]: 4 } })) };
const server = createServer((req, res) => {
  const m = /^\/(raw|gzip|br)\/(\d+)/.exec(req.url ?? "");
  if (!m) { res.writeHead(200, { "content-type": "text/html" }); res.end("<!doctype html><title>c</title>ok"); return; }
  const kind = m[1] as keyof typeof enc; const body = enc[kind][Number(m[2])];
  res.writeHead(200, { "content-type": "application/octet-stream", "content-length": body.byteLength, ...(kind === "raw" ? {} : { "content-encoding": kind }), "cache-control": "no-store" });
  res.end(Buffer.from(body));
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const port = (server.address() as { port: number }).port;
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", args: ["--no-sandbox"] });
const page = await (await browser.newContext()).newPage();
await page.goto(`http://127.0.0.1:${port}/`);
const n = chunks.length;
const results: Record<string, unknown> = { count, chunks: n, bytes: { raw: enc.raw.reduce((a, c) => a + c.byteLength, 0), gzip: enc.gzip.reduce((a, c) => a + c.byteLength, 0), br: enc.br.reduce((a, c) => a + c.byteLength, 0) } };
for (const kind of ["raw", "gzip", "br"]) {
  for (let rep = 0; rep < 2; rep++) {
    const r = await page.evaluate(async ({ kind, n }) => {
      const t0 = performance.now(); let bytes = 0;
      for (let i = 0; i < n; i++) { const b = await (await fetch(`/${kind}/${i}`)).arrayBuffer(); bytes += b.byteLength; new Float32Array(b, 0, 4); }
      const ms = performance.now() - t0;
      const entries = performance.getEntriesByType("resource").filter((e) => e.name.includes(`/${kind}/`)) as PerformanceResourceTiming[];
      return { ms, bytes, avgResponseMs: entries.length ? entries.reduce((a, e) => a + (e.responseEnd - e.requestStart), 0) / entries.length : 0 };
    }, { kind, n });
    if (rep === 1) { results[kind] = { totalMs: r.ms, msPerChunk: r.ms / n, decodedBytes: r.bytes, avgResponseMs: r.avgResponseMs }; console.log(`${kind}: ${n} chunks ${r.ms.toFixed(0)} ms (${(r.ms / n).toFixed(2)} ms/chunk, response avg ${r.avgResponseMs.toFixed(2)} ms)`); }
  }
}
await browser.close(); server.close();
if (out) { writeFileSync(out, JSON.stringify(results, null, 2)); console.log(`wrote ${out}`); }
