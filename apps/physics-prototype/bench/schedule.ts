/**
 * Drop scheduling 벤치마크 (Phase 0.5 §6).
 * T-60초 cutoff 안에 100k Drop 의 최종 Transform 을 계산할 수 있는지 반복 측정한다.
 *   tsx bench/schedule.ts --target 100000 --runs 5 --preset natural --out ../../docs/benchmarks/phase0.5-schedule.json
 * 기록: wall time p50/p95, 실패 수, 최대 RSS.
 */
import RAPIER from "@dimforge/rapier3d-compat";
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { TowerSim, PRESETS, type PresetName } from "../src/sim";

const argv = process.argv.slice(2);
const opt = (k: string, d: string): string => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const target = Number(opt("--target", "100000"));
const runs = Number(opt("--runs", "5"));
const preset = opt("--preset", "natural") as PresetName;
const cutoffSec = Number(opt("--cutoff", "60"));
const out = opt("--out", "");

await RAPIER.init();
const walls: number[] = [];
let failures = 0;
let peakRss = 0;
const details: unknown[] = [];
for (let run = 0; run < runs; run++) {
  const t0 = performance.now();
  let ok = true;
  let err = "";
  let leaks = 0;
  let steps = 0;
  try {
    const sim = new TowerSim(RAPIER, target, { ...PRESETS[preset], seed: 1000 + run });
    while (sim.spawned < target || sim.batchInFlight) {
      if (!sim.batchInFlight && sim.spawned < target) sim.queueBatch(Math.min(sim.cfg.batchSize, target - sim.spawned));
      sim.step();
      if (++steps % 2000 === 0) peakRss = Math.max(peakRss, process.memoryUsage().rss);
    }
    leaks = sim.leakCount;
    const m = sim.metrics();
    if (leaks > 0 || m.belowGround > 0 || m.nonFinite > 0) { ok = false; err = `leaks ${leaks} belowGround ${m.belowGround} nonFinite ${m.nonFinite}`; }
    sim.free();
  } catch (e) { ok = false; err = String(e); }
  const wall = (performance.now() - t0) / 1000;
  peakRss = Math.max(peakRss, process.memoryUsage().rss);
  if (!ok || wall > cutoffSec) failures++;
  walls.push(wall);
  details.push({ run, wallSec: wall, ok, err, steps, leaks, withinCutoff: wall <= cutoffSec });
  console.log(`run ${run + 1}/${runs}: ${wall.toFixed(1)} s ${ok ? "ok" : "FAIL " + err} ${wall <= cutoffSec ? "" : "(over cutoff)"}`);
}
const sorted = [...walls].sort((a, b) => a - b);
const q = (p: number): number => sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))];
const summary = { target, preset, runs, cutoffSec, p50: q(0.5), p95: q(0.95), min: sorted[0], max: sorted[sorted.length - 1], failures, peakRssMB: peakRss / 1048576, details, node: process.version, generatedAt: new Date().toISOString() };
console.log(`p50 ${summary.p50.toFixed(1)} s  p95 ${summary.p95.toFixed(1)} s  max ${summary.max.toFixed(1)} s  failures ${failures}/${runs}  peak RSS ${summary.peakRssMB.toFixed(0)} MB`);
if (out) { mkdirSync(resolve(out, ".."), { recursive: true }); writeFileSync(resolve(out), JSON.stringify(summary, null, 2)); console.log(`wrote ${resolve(out)}`); }
