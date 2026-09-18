/**
 * Phase 0.75 스위트 러너를 headless Chromium 에서 자동 등급 모드로 끝까지 돌려 절차를 검증한다.
 * (SwiftShader 이므로 성능 수치는 참고용. 실제 기기 결과는 기기에서 /?suite=all 로 수집한다.)
 *   pnpm build && tsx bench/suite.ts --device headless-swiftshader
 */
import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const argv = process.argv.slice(2);
const opt = (k: string, d: string): string => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const device = opt("--device", "headless-swiftshader");
const outDir = resolve(opt("--out", "../../docs/benchmarks/raw"));
const exe = opt("--chromium", process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome");
const port = 4175;
mkdirSync(outDir, { recursive: true });

const server = spawn("npx", ["vite", "preview", "--port", String(port), "--strictPort"], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 1500));
try {
  const browser = await chromium.launch({ executablePath: exe, args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox"] });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  page.on("console", (m) => { if (m.type() === "error") console.error("  [page]", m.text()); });
  await page.goto(`http://localhost:${port}/?suite=reset`);
  await page.waitForFunction(() => location.search.includes("suite=results"), null, { timeout: 60000 });
  const t0 = Date.now();
  await page.goto(`http://localhost:${port}/?suite=all&fresh=1&grade=auto&device=${encodeURIComponent(device)}`);
  // 단계마다 reload 되므로 results 페이지에 도달할 때까지 기다린다
  let last = "";
  while (Date.now() - t0 < 40 * 60 * 1000) {
    await page.waitForTimeout(2000);
    const url = page.url();
    if (url !== last) { console.log(`  ${((Date.now() - t0) / 1000).toFixed(0)}s ${url.replace(/^http:\/\/[^/]+/, "")}`); last = url; }
    if (url.includes("suite=results")) {
      const ready = await page.evaluate(() => Boolean(window.__READY)).catch(() => false);
      if (ready) break;
    }
  }
  const run = await page.evaluate(() => (window as unknown as { __RUN?: unknown }).__RUN);
  const file = resolve(outDir, `phase0.75-${device}.json`);
  writeFileSync(file, JSON.stringify(run, null, 2));
  await page.screenshot({ path: resolve(outDir, `phase0.75-${device}-results.png`), fullPage: true });
  console.log(`wrote ${file}`);
  const steps = (run as { steps: { id: string; status: string; result?: Record<string, unknown> }[] }).steps;
  for (const s of steps) console.log(`  ${s.id.padEnd(28)} ${s.status.padEnd(8)} fps ${(s.result?.fps as number | undefined)?.toFixed(1) ?? "—"}  p95 ${(s.result?.frameMsP95 as number | undefined)?.toFixed(0) ?? "—"} ms  draw ${s.result?.drawCalls ?? "—"}  visible ${s.result?.visibleInstances ?? "—"}`);
  await browser.close();
} finally {
  server.kill();
}
