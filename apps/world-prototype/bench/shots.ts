/**
 * world-prototype 스크린샷/구조 검증 (headless Chromium + SwiftShader).
 *   pnpm build && tsx bench/shots.ts [--counts 100000,500000,1000000]
 * 산출: docs/benchmarks/phase1/*.png, phase1-world-structural.json
 */
import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const argv = process.argv.slice(2);
const opt = (k: string, d: string): string => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const outDir = resolve(opt("--out", "../../docs/benchmarks/phase1"));
const counts = opt("--counts", "100000,500000,1000000").split(",").map(Number);
const exe = opt("--chromium", process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome");
const port = 4176;
mkdirSync(outDir, { recursive: true });
const server = spawn("npx", ["vite", "preview", "--port", String(port), "--strictPort"], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 1500));
const results: Record<string, unknown> = {};
try {
  const browser = await chromium.launch({ executablePath: exe, args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox"] });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const run = async (name: string, query: string, shot = true): Promise<Record<string, unknown> | null> => {
    const page = await ctx.newPage();
    page.on("console", (m) => { if (m.type() === "error") console.error("  [page]", m.text()); });
    await page.goto(`http://localhost:${port}/?${query}`);
    await page.waitForFunction(() => Boolean(window.__READY), null, { timeout: 15 * 60 * 1000, polling: 500 });
    const r = (await page.evaluate(() => window.__RESULT ?? (window.__snapshot ? window.__snapshot() : null))) as Record<string, unknown> | null;
    if (shot) await page.screenshot({ path: resolve(outDir, `${name}.png`), timeout: 10 * 60 * 1000 });
    await page.close();
    console.log(`  ${name}: rendered ${r?.renderedInstances} lod ${JSON.stringify(r?.lodCounts)} draw ${r?.drawCalls} chunks ${r?.gpuChunks}/${r?.chunks} height ${(r?.towerHeightM as number)?.toFixed?.(1)} m`);
    results[name] = r;
    return r;
  };
  // 구조 검증: 100k / 500k / 1M (top view, auto)
  for (const n of counts) await run(`structural-${n}`, `synthetic=${n}&auto=1&quality=performance&view=top&settle=4000&shot=1`);
  // Find, full, height mode, far view A/B/C (100k)
  await run("find-54321", `synthetic=100000&find=54321&auto=1&quality=standard&settle=6000&shot=1`);
  await run("height-mode", `synthetic=100000&view=height&auto=1&quality=performance&settle=3000&shot=1`);
  for (const far of ["pure", "silhouette", "atmospheric"]) await run(`far-${far}`, `synthetic=100000&view=full&far=${far}&auto=1&quality=performance&settle=4000&shot=1`);
  // 원거리 비교: 중간 거리(팬케이크 ≈ 1 px) 에서도 세 방식 비교
  // 팬케이크 투영 직경 ≈ 1 px 가 되는 거리 (800 px, FOV 50°: d ≈ 860 units) 와 ≈ 0.3 px (d ≈ 2,500)
  for (const far of ["pure", "silhouette", "atmospheric"]) await run(`far-mid-${far}`, `synthetic=100000&view=far:860&far=${far}&auto=1&quality=performance&settle=4000&shot=1&reducedMotion=1`);
  // Continuous drop + replay (브라우저 내 서버 역할) — 100k 위 5,000 장
  await run("drop-5000-replay", `synthetic=100000&drop=5000&auto=1&quality=performance&settle=2000&shot=1`);
  await browser.close();
  writeFileSync(resolve(outDir, "phase1-world-structural.json"), JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2));
} finally { server.kill(); }
