/**
 * 브라우저 자동 벤치마크: vite preview 로 dist 를 띄우고 headless Chromium 에서 auto 모드를 실행한다.
 *   pnpm build && tsx bench/browser.ts --targets 1000,10000 --quality standard --release
 * 샌드박스/CI 의 GPU 는 소프트웨어 렌더러이므로 FPS 는 참고용. 실제 기기 측정은 `pnpm dev` 로 접속해 EXPORT JSON.
 */
import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const argv = process.argv.slice(2);
const opt = (k: string, d: string): string => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const targets = opt("--targets", "1000").split(",").map(Number);
const quality = opt("--quality", "standard");
const release = argv.includes("--release");
const outDir = resolve(opt("--out", "../../docs/benchmarks"));
const exe = opt("--chromium", process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome");
const port = 4173;

const server = spawn("npx", ["vite", "preview", "--port", String(port), "--strictPort"], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 1500));
try {
  const browser = await chromium.launch({ executablePath: exe, args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox"] });
  const results: unknown[] = [];
  for (const target of targets) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    page.on("console", (m) => { if (m.type() === "error") console.error("  [page]", m.text()); });
    const url = `http://localhost:${port}/?target=${target}&auto=1&quality=${quality}&stepsPerFrame=4${release ? "&release=1" : ""}`;
    console.log(`=== ${target} (${quality}) ${url}`);
    await page.goto(url);
    const t0 = Date.now();
    await page.waitForFunction(() => Boolean(window.__RESULT), null, { timeout: 30 * 60 * 1000, polling: 1000 });
    const r = (await page.evaluate(() => window.__RESULT)) as Record<string, unknown>;
    r.wallMs = Date.now() - t0;
    const wallMs = r.wallMs as number;
    console.log(`  fps ${(r.fps as number).toFixed(1)}  frame ${(r.frameMsAvg as number).toFixed(1)} ms  physics ${(r.physMsPerStepAvg as number).toFixed(2)} ms/step  tower ${(r.towerHeightM as number).toFixed(2)} m  draw calls ${r.drawCalls}  tris ${r.triangles}  heap ${r.jsHeapMB === null ? "n/a" : (r.jsHeapMB as number).toFixed(0) + " MB"}  gpu ${r.gpu}  wall ${(wallMs / 1000).toFixed(1)} s`);
    mkdirSync(outDir, { recursive: true });
    await page.screenshot({ path: resolve(outDir, `phase0-browser-${target}-${quality}.png`) });
    results.push(r);
    await page.close();
  }
  writeFileSync(resolve(outDir, `phase0-browser-${quality}.json`), JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2));
  await browser.close();
} finally {
  server.kill();
}
