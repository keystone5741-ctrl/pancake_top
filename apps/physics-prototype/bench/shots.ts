/**
 * Phase 0.5 시각 검증 스크린샷 + 100k 장면 + Replay 수렴 검증 (headless Chromium, SwiftShader).
 *   pnpm build && tsx bench/shots.ts
 * 산출: docs/benchmarks/phase0.5-*.png, phase0.5-scenes.json
 */
import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const argv = process.argv.slice(2);
const opt = (k: string, d: string): string => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const outDir = resolve(opt("--out", "../../docs/benchmarks"));
const exe = opt("--chromium", process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome");
const port = 4174;
const from = opt("--from", "presets"); // presets | 100k | synthetic
mkdirSync(outDir, { recursive: true });

const server = spawn("npx", ["vite", "preview", "--port", String(port), "--strictPort"], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 1500));
const results: Record<string, unknown> = {};
try {
  const browser = await chromium.launch({ executablePath: exe, args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox"] });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });

  const shot = async (name: string, query: string): Promise<Record<string, unknown> | null> => {
    const page = await ctx.newPage();
    page.on("console", (m) => { if (m.type() === "error") console.error("  [page]", m.text()); });
    await page.goto(`http://localhost:${port}/?${query}`);
    await page.waitForFunction(() => Boolean(window.__READY), null, { timeout: 20 * 60 * 1000, polling: 500 });
    await page.screenshot({ path: resolve(outDir, `${name}.png`), timeout: 10 * 60 * 1000 });
    const r = (await page.evaluate(() => window.__RESULT ?? null)) as Record<string, unknown> | null;
    await page.close();
    console.log(`  ${name}${r ? `  fps ${(r.fps as number).toFixed(1)} draw ${r.drawCalls} inst ${r.instances}` : ""}`);
    return r;
  };

  // 1) 프리셋 비교: 10k, 측면 / 상단 / 45도 (플랜 §4)
  for (const preset of from === "presets" ? ["stable", "natural", "loose"] : []) {
    console.log(`=== preset ${preset}`);
    for (const view of ["side", "top", "iso"]) {
      await shot(`phase0.5-preset-${preset}-${view}`, `load=towers/10k-${preset}.bin&view=${view}&shot=1&colorState=0`);
    }
    await shot(`phase0.5-preset-${preset}-peak`, `load=towers/10k-${preset}.bin&view=peak&shot=1&colorState=0`);
  }

  // 2) 100k 장면: 전체 / 중간 확대 / 최상단 / Find Pancake (플랜 §9)
  // SwiftShader 에서 100k 는 프레임당 수십 초가 걸리므로 performance 품질로 찍는다 (장면 검증 목적).
  if (from === "presets" || from === "100k") {
    console.log("=== 100k scenes");
    for (const view of ["full", "mid", "peak", "find:54321"]) {
      const name = view.replace(":", "-");
      await shot(`phase0.5-100k-${name}`, `load=towers/100000-natural.bin&view=${view}&shot=1&colorState=0&quality=performance`);
    }

    // 3) 100k 로드 모드 자동 측정 (렌더링만) + Replay 수렴 검증 (§7)
    console.log("=== 100k loaded auto + replay");
    results.loaded100k = await shot("phase0.5-100k-auto", `load=towers/100000-natural.bin&view=peak&auto=1&replay=2000&colorState=0&settle=6000&quality=performance`);
    const rep = results.loaded100k as Record<string, unknown> | null;
    if (rep?.replay) console.log("  replay:", JSON.stringify(rep.replay));
  }

  // 4) 합성 탑 렌더링 (500k / 1M) — 실제 기기 절차 확인용. SwiftShader 이므로 FPS 는 참고용.
  for (const n of [500000, 1000000]) {
    console.log(`=== synthetic ${n}`);
    results[`synthetic${n}`] = await shot(`phase0.5-synthetic-${n}`, `synthetic=${n}&view=full&auto=1&quality=performance&colorState=0&settle=6000`);
  }

  await browser.close();
  writeFileSync(resolve(outDir, "phase0.5-scenes.json"), JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2));
} finally {
  server.kill();
}
