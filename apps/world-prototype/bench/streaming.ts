/**
 * Phase 2 §41, §42, §46: 서버 모드 스트리밍 검증 (headless Chromium + SwiftShader, FPS 는 의미 없음 — 구조만).
 *   (world-server 를 1M 합성 월드로 띄운 뒤)  pnpm build && tsx bench/streaming.ts [--server http://localhost:8787]
 * 산출: docs/benchmarks/phase2/*.png, phase2-streaming.json
 *   - Full Tower / Top 에서 실제로 받은 chunk 수와 바이트
 *   - Find #1 / #54321 / #999999: 필요한 chunk 만 받는지, "Loading pancake…" 상태가 뜨는지
 *   - 네트워크 throttling (Fast 4G / 3G / Slow 3G) 에서 Find 완료까지 시간
 */
import { chromium, type Page } from "playwright-core";
import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const argv = process.argv.slice(2);
const opt = (k: string, d: string): string => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const outDir = resolve(opt("--out", "../../docs/benchmarks/phase2"));
const serverUrl = opt("--server", "http://localhost:8787");
const exe = opt("--chromium", process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome");
const port = 4177;
const only = opt("--only", ""); // "throttle" 이면 throttling 시나리오만
mkdirSync(outDir, { recursive: true });
const manifest = (await (await fetch(`${serverUrl}/api/world/manifest`)).json()) as { version: number; totalPancakes: number; chunks: { byteLength: number }[]; heightMeters: number };
console.log(`server world v${manifest.version}: ${manifest.totalPancakes} pancakes, ${manifest.chunks.length} chunks, ${(manifest.chunks.reduce((a, c) => a + c.byteLength, 0) / 1048576).toFixed(1)} MB, height ${manifest.heightMeters.toFixed(1)} m`);
const preview = spawn("npx", ["vite", "preview", "--port", String(port), "--strictPort"], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 1500));
const results: Record<string, unknown> = { server: serverUrl, manifest: { version: manifest.version, totalPancakes: manifest.totalPancakes, chunks: manifest.chunks.length } };
const PROFILES: Record<string, { download: number; upload: number; latency: number }> = {
  "fast-4g": { download: (4 * 1024 * 1024) / 8, upload: (3 * 1024 * 1024) / 8, latency: 20 },
  "3g": { download: (1.6 * 1024 * 1024) / 8, upload: (750 * 1024) / 8, latency: 150 },
  "slow-3g": { download: (400 * 1024) / 8, upload: (400 * 1024) / 8, latency: 400 },
};
try {
  const browser = await chromium.launch({ executablePath: exe, args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox"] });
  // 시나리오마다 새 context: 브라우저 HTTP 캐시(immutable chunk)가 다음 시나리오의 네트워크 수치를 가리지 않게
  const open = async (query: string, throttle?: string): Promise<{ page: Page; requests: { url: string; bytes: number; ms: number }[] }> => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    const requests: { url: string; bytes: number; ms: number }[] = [];
    page.on("console", (m) => { if (m.type() === "error") console.error("  [page]", m.text()); });
    page.on("response", async (r) => { const u = r.url(); if (u.includes("/api/world/chunks/")) { const t = r.request().timing(); try { requests.push({ url: u, bytes: (await r.body()).byteLength, ms: t.responseEnd - t.requestStart }); } catch { requests.push({ url: u, bytes: 0, ms: 0 }); } } });
    if (throttle) { const cdp = await ctx.newCDPSession(page); await cdp.send("Network.enable"); await cdp.send("Network.emulateNetworkConditions", { offline: false, downloadThroughput: PROFILES[throttle].download, uploadThroughput: PROFILES[throttle].upload, latency: PROFILES[throttle].latency }); }
    await page.goto(`http://localhost:${port}/?source=server&server=${encodeURIComponent(serverUrl)}&quality=performance&${query}`);
    return { page, requests };
  };
  const snap = (page: Page): Promise<Record<string, any>> => page.evaluate(() => window.__snapshot!()) as Promise<Record<string, any>>;
  const run = async (name: string, query: string, throttle?: string, shot = true): Promise<Record<string, unknown>> => {
    const t0 = Date.now();
    const { page, requests } = await open(query, throttle);
    await page.waitForFunction(() => Boolean(window.__READY), null, { timeout: 15 * 60 * 1000, polling: 500 });
    const s = await snap(page);
    if (shot) await page.screenshot({ path: resolve(outDir, `${name}.png`), timeout: 10 * 60 * 1000 });
    const r = { wallMs: Date.now() - t0, policy: s.streamingPolicy, count: s.count, chunks: s.chunks, loadedChunks: s.loadedChunks, gpuChunks: s.gpuChunks, renderedInstances: s.renderedInstances, lodCounts: s.lodCounts, towerHeightM: s.towerHeightM, chunkFetches: s.remote?.chunkFetches, bytesDownloadedMB: (s.remote?.bytesDownloaded ?? 0) / 1048576, cacheHits: s.remote?.cacheHits, checksumFailures: s.remote?.checksumFailures, wsStatus: s.remote?.wsStatus, selected: s.selected, httpChunkRequests: requests.length, httpChunkMB: requests.reduce((a, x) => a + x.bytes, 0) / 1048576 };
    console.log(`  ${name}: loaded ${r.loadedChunks}/${r.chunks} chunks (fetched ${r.chunkFetches}, ${r.bytesDownloadedMB.toFixed(2)} MB, http ${r.httpChunkRequests}), rendered ${r.renderedInstances}, height ${Number(r.towerHeightM).toFixed(1)} m, ws ${r.wsStatus}${r.selected ? `, selected #${r.selected.id + 1} chunk ${r.selected.chunkId}` : ""} [${(r.wallMs / 1000).toFixed(1)} s]`);
    await page.close();
    results[name] = r;
    return r;
  };
  if (!only) await run("server-top", "view=top&auto=1&settle=8000");
  if (!only) for (const id of [1, 54321, 999999]) await run(`server-find-${id}`, `find=${id}&auto=1&settle=8000`);
  // "Loading pancake…" 상태 + 필요한 chunk 만: 페이지를 열고 직접 find 를 호출해 상태 텍스트를 관찰한다
  if (!only) {
    const { page, requests } = await open("view=top&shot=1&settle=1000");
    await page.waitForFunction(() => Boolean(window.__READY), null, { timeout: 60_000 });
    const before = (await snap(page)).remote.chunkFetches as number;
    const texts: string[] = [];
    const t0 = Date.now();
    const finding = page.evaluate(() => window.__find!(54321));
    while (Date.now() - t0 < 30_000) { const t = await page.$eval("#dropStatus", (el) => el.textContent ?? ""); if (!texts.length || texts[texts.length - 1] !== t) texts.push(t); if (/→ chunk/.test(t)) break; await new Promise((r) => setTimeout(r, 20)); }
    await finding;
    const after = await snap(page);
    results["find-status"] = { texts, sawLoading: texts.some((t) => t.startsWith("Loading pancake")), chunkFetchesDelta: (after.remote.chunkFetches as number) - before, httpChunkUrls: requests.map((r) => r.url.replace(serverUrl, "")), selected: after.selected, ms: Date.now() - t0 };
    console.log(`  find-status: ${JSON.stringify(texts)} fetched +${(after.remote.chunkFetches as number) - before} chunk(s) in ${Date.now() - t0} ms`);
    await page.close();
  }
  // throttling: Find #999999 (맨 위 chunk 하나 + 이웃) 완료까지
  for (const prof of Object.keys(PROFILES)) {
    const t0 = Date.now();
    const { page, requests } = await open("view=top&shot=1&settle=500", prof);
    await page.waitForFunction(() => Boolean(window.__READY), null, { timeout: 120_000 });
    const tFind = Date.now();
    const finding = page.evaluate(() => window.__find!(500000));
    const texts: string[] = [];
    let done = false; void finding.then(() => { done = true; });
    while (!done) { const t = await page.$eval("#dropStatus", (el) => el.textContent ?? ""); if (!texts.length || texts[texts.length - 1] !== t) texts.push(t); await new Promise((r) => setTimeout(r, 50)); }
    const s = await snap(page);
    const r = { profile: PROFILES[prof], pageReadyMs: tFind - t0, findMs: Date.now() - tFind, chunkFetches: s.remote.chunkFetches, bytesMB: s.remote.bytesDownloaded / 1048576, httpChunkRequests: requests.length, avgChunkMs: requests.length ? requests.reduce((a, x) => a + x.ms, 0) / requests.length : 0, selected: s.selected, statusTexts: texts, sawLoading: texts.some((t) => t.startsWith("Loading pancake")) };
    console.log(`  throttle ${prof}: page ready ${r.pageReadyMs} ms, find #500000 ${r.findMs} ms (${r.chunkFetches} chunks, ${r.bytesMB.toFixed(2)} MB, avg chunk ${r.avgChunkMs.toFixed(0)} ms) status ${JSON.stringify(texts)}`);
    results[`throttle-${prof}`] = r;
    await page.close();
  }
  // Full Tower 는 모든 chunk 가 보이므로 100 개를 다 받는다 (SwiftShader 에서는 1M 인스턴스 렌더가 매우 느려 마지막에 둔다)
  if (!only) await run("server-full", "view=full&auto=1&settle=4000");
  await browser.close();
  const file = resolve(outDir, only ? `phase2-streaming-${only}.json` : "phase2-streaming.json");
  writeFileSync(file, JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2));
  console.log(`wrote ${file}`);
} finally { preview.kill(); }
