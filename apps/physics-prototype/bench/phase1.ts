/**
 * Phase 1 physics benchmarks (spec §23, §24, §34).
 *   tsx bench/phase1.ts --base public/towers/100000-natural.bin --out ../../docs/benchmarks/phase1
 *  1) continuous: 100k 위 +100 / +1k / +5k / +10k / +25k (ContinuousDropSimulator, top-64)
 *  2) incremental vs batch: 10k 한 번에 vs 100장 × 100회 (같은 seed)
 *  3) regression: Natural 100k 을 다시 쌓아 Phase 0.5 metrics 와 비교
 */
import RAPIER from "@dimforge/rapier3d-compat";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { ContinuousDropSimulator, PRESETS, TowerSim, TopNSurfaceProvider, computeStackingMetrics, decodeTower, formatMetrics, type TowerData, type StackingMetrics } from "pancake-physics";

const argv = process.argv.slice(2);
const opt = (k: string, d: string): string => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const basePath = opt("--base", "public/towers/100000-natural.bin");
const outDir = resolve(opt("--out", "../../docs/benchmarks/phase1"));
const only = opt("--only", "all");
mkdirSync(outDir, { recursive: true });
await RAPIER.init();
const buf = readFileSync(basePath);
const base: TowerData = decodeTower(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
const rss = (): number => process.memoryUsage().rss / 1048576;
const metricsOf = (t: TowerData): StackingMetrics => computeStackingMetrics(t);

// ---------------------------------------------------------------- 1) continuous workloads
if (only === "all" || only === "continuous") {
  const rows: unknown[] = [];
  for (const n of [100, 1000, 5000, 10000, 25000]) {
    const t0 = performance.now();
    const c = new ContinuousDropSimulator(RAPIER, { capacity: base.count + n, base, surfaceProvider: new TopNSurfaceProvider(64), config: { ...PRESETS.natural, seed: 777 } });
    const loadMs = performance.now() - t0;
    c.createDrop("D");
    // 구매가 100장씩 들어온다고 가정하고 즉시 계산
    let peak = rss();
    const t1 = performance.now();
    for (let sent = 0; sent < n; sent += 100) { c.enqueuePancakes("D", Math.min(100, n - sent)); c.processPending(50); peak = Math.max(peak, rss()); }
    c.closeDrop("D");
    c.finalizeDrop("D");
    const simMs = performance.now() - t1;
    const r = c.getDropResult("D");
    const m = metricsOf(c.towerSnapshot());
    rows.push({ added: n, loadMs, simulationMs: simMs, msPerPancake: simMs / n, peakRssMB: peak, surfaceColliders: c.surfaceColliderCount, heightBeforeM: (r.heightBefore * base.unitCm) / 100, heightAfterM: (r.heightAfter * base.unitCm) / 100, penetration: m.penetration, tilt: m.tilt, spread: m.spread });
    console.log(`+${n}: load ${loadMs.toFixed(0)} ms, sim ${(simMs / 1000).toFixed(2)} s (${(simMs / n).toFixed(3)} ms/pancake), peak RSS ${peak.toFixed(0)} MB, height ${((r.heightAfter * base.unitCm) / 100).toFixed(2)} m, pen max ${m.penetration.max.toFixed(3)} p95 ${m.penetration.p95.toFixed(3)}`);
    c.free();
  }
  writeFileSync(resolve(outDir, "phase1-continuous-on-100k.json"), JSON.stringify({ generatedAt: new Date().toISOString(), base: base.count, rows }, null, 2));
}

// ---------------------------------------------------------------- 2) incremental vs batch (10k)
if (only === "all" || only === "incremental") {
  const N = 10000;
  const tA = performance.now();
  const a = new ContinuousDropSimulator(RAPIER, { capacity: base.count + N, base, config: { ...PRESETS.natural, seed: 4242 } });
  a.createDrop("A"); a.enqueuePancakes("A", N); a.finalizeDrop("A");
  const msA = performance.now() - tA;
  const mA = metricsOf(a.getDropResult("A").finalTransforms);
  const hA = a.getDropResult("A").heightAfter;
  a.free();
  const tB = performance.now();
  const b = new ContinuousDropSimulator(RAPIER, { capacity: base.count + N, base, config: { ...PRESETS.natural, seed: 4242 } });
  for (let i = 0; i < 100; i++) { const id = `B${i}`; b.createDrop(id); b.enqueuePancakes(id, 100); b.finalizeDrop(id); }
  const msB = performance.now() - tB;
  const mB = metricsOf(b.towerSnapshot() && sliceLast(b.towerSnapshot(), N));
  const hB = b.towerHeight;
  b.free();
  console.log(`batch 10k: ${(msA / 1000).toFixed(2)} s height ${((hA * base.unitCm) / 100).toFixed(2)} m\n${formatMetrics(mA)}`);
  console.log(`incremental 100×100: ${(msB / 1000).toFixed(2)} s height ${((hB * base.unitCm) / 100).toFixed(2)} m\n${formatMetrics(mB)}`);
  writeFileSync(resolve(outDir, "phase1-incremental-vs-batch.json"), JSON.stringify({ generatedAt: new Date().toISOString(), n: N, batch: { ms: msA, heightAfterM: (hA * base.unitCm) / 100, metrics: mA }, incremental: { ms: msB, drops: 100, perDrop: 100, heightAfterM: (hB * base.unitCm) / 100, metrics: mB } }, null, 2));
}

// ---------------------------------------------------------------- 3) regression: natural 100k
if (only === "all" || only === "regression") {
  const ref = JSON.parse(readFileSync(resolve(outDir, "../phase0.5-sizes-natural.json"), "utf8")).results.find((r: { target: number }) => r.target === 100000);
  const t0 = performance.now();
  const sim = new TowerSim(RAPIER, 100000, { ...PRESETS.natural });
  while (sim.spawned < 100000 || sim.batchInFlight) { if (!sim.batchInFlight) sim.queueBatch(Math.min(500, 100000 - sim.spawned)); sim.step(); }
  const ms = performance.now() - t0;
  const m = sim.metrics();
  sim.free();
  const cmp = {
    height: [ref.metrics.height.towerM, m.height.towerM], tiltMedian: [ref.metrics.tilt.median, m.tilt.median], tiltP95: [ref.metrics.tilt.p95, m.tilt.p95],
    spreadMax: [ref.metrics.spread.max, m.spread.max], layerMedian: [ref.metrics.layerSpacing.median, m.layerSpacing.median],
    penetrationMax: [ref.metrics.penetration.max, m.penetration.max], penetrationP95: [ref.metrics.penetration.p95, m.penetration.p95], penetrationPairs: [ref.metrics.penetration.overlappingPairs, m.penetration.overlappingPairs],
  };
  const identical = Object.values(cmp).every(([a, b]) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a)));
  console.log(`regression natural 100k: ${(ms / 1000).toFixed(1)} s, identical to Phase 0.5: ${identical}`);
  for (const [k, [a, b]] of Object.entries(cmp)) console.log(`  ${k.padEnd(16)} ${a} → ${b}`);
  writeFileSync(resolve(outDir, "phase1-regression-natural-100k.json"), JSON.stringify({ generatedAt: new Date().toISOString(), simulationMs: ms, identical, comparison: cmp, metrics: m }, null, 2));
}

function sliceLast(t: TowerData, n: number): TowerData {
  const from = t.count - n;
  return { count: n, diameter: t.diameter, thickness: t.thickness, unitCm: t.unitCm, px: t.px.slice(from), py: t.py.slice(from), pz: t.pz.slice(from), qx: t.qx.slice(from), qy: t.qy.slice(from), qz: t.qz.slice(from), qw: t.qw.slice(from), scale: t.scale.slice(from), tscale: t.tscale.slice(from) };
}
