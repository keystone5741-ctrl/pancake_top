/**
 * Physics scaling research (Phase 3A §4): 순차 기준(A) vs 투기적 병렬(C) 비교 — 연구용, production 미사용.
 *   pnpm --filter world-server bench:speculative -- [--count 3000] [--batch 100] [--seeds 3]
 * C: worker 2개가 같은 표면 N 을 보고 batch N+1 과 N+2 를 동시에 계산한다고 가정한다. N+2 의 결과가 authoritative(N+1 을 반영한 표면) 결과와
 *    얼마나 다른지 잰다. 다르면 재계산 → 그 비율이 곧 낭비다. 위치 차이가 threshold 를 넘으면 "불일치".
 * 물리 lane 은 반드시 하나(§3) — 여기서는 그 원칙이 왜 필요한지 수치로 확인한다.
 */
import RAPIER from "@dimforge/rapier3d-compat";
import { PRESETS, TopNSurfaceProvider, TowerSim, decodeTower, encodeTower, type TowerData } from "pancake-physics";

const argv = process.argv.slice(2);
const opt = (k: string, d: string): string => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const count = Number(opt("--count", "3000")), batch = Number(opt("--batch", "100")), seeds = Number(opt("--seeds", "3"));
const threshold = Number(opt("--threshold", "0.05")); // units (0.5 cm)
await RAPIER.init();

function run(sim: TowerSim, n: number): void { const goal = sim.spawned + n; while (sim.spawned < goal || sim.batchInFlight) { if (!sim.batchInFlight && sim.spawned < goal) sim.queueBatch(Math.min(batch, goal - sim.spawned)); sim.step(); } }
function topK(t: TowerData, k: number): TowerData { const idx = Array.from({ length: t.count }, (_, i) => i).sort((a, b) => t.py[b] - t.py[a]).slice(0, k).sort((a, b) => a - b); const pick = (a: Float32Array): Float32Array => Float32Array.from(idx, (i) => a[i]); return { count: idx.length, diameter: t.diameter, thickness: t.thickness, unitCm: t.unitCm, px: pick(t.px), py: pick(t.py), pz: pick(t.pz), qx: pick(t.qx), qy: pick(t.qy), qz: pick(t.qz), qw: pick(t.qw), scale: pick(t.scale), tscale: pick(t.tscale) }; }
function fresh(surface: TowerData | null, seed: number, cap: number): TowerSim { const s = new TowerSim(RAPIER, cap, { ...PRESETS.natural, seed }); if (surface && surface.count) s.loadBase(surface, new TopNSurfaceProvider(64).getSurfaceColliders(surface)); return s; }

const results = [];
for (let seed = 1; seed <= seeds; seed++) {
  // A. 순차: 하나의 sim 이 batch 를 이어서 쌓는다 (authoritative)
  const tA = performance.now();
  const auth = fresh(null, seed, count);
  const surfaces: TowerData[] = []; const outputs: TowerData[] = [];
  for (let done = 0; done < count; done += batch) { surfaces.push(topK(auth.snapshot(), 512)); const from = auth.spawned; run(auth, Math.min(batch, count - done)); outputs.push(auth.snapshot(from)); }
  const sequentialMs = performance.now() - tA;
  // C. 투기: batch i+1 을 표면 i (i+1 이 아닌) 위에서 계산 → authoritative 결과와 비교
  let mismatches = 0, compared = 0, maxDelta = 0, specMs = 0;
  for (let i = 0; i + 1 < outputs.length; i++) {
    const t0 = performance.now();
    const spec = fresh(decodeTower(encodeTower(surfaces[i])), seed, 1024);
    // 같은 rng 흐름을 흉내낼 수 없으므로 동일 seed 로 batch i 와 i+1 을 연달아 뽑되, batch i 의 결과를 표면에 반영하지 않는다 (= 다른 worker 가 동시에 계산)
    run(spec, outputs[i].count); // 이 worker 의 batch i (버림)
    const from = spec.spawned; run(spec, outputs[i + 1].count);
    const s = spec.snapshot(from), a = outputs[i + 1];
    specMs += performance.now() - t0;
    let bad = 0; for (let k = 0; k < a.count; k++) { const d = Math.hypot(s.px[k] - a.px[k], s.py[k] - a.py[k], s.pz[k] - a.pz[k]); if (d > maxDelta) maxDelta = d; if (d > threshold) bad++; }
    compared++; if (bad > 0) mismatches++;
    spec.free();
  }
  const r = { seed, count, batch, sequentialMs, batchesCompared: compared, batchesMismatched: mismatches, recomputeRate: compared ? mismatches / compared : 0, maxPositionDeltaUnits: maxDelta, speculativeWorkMs: specMs, heightM: auth.towerHeightMeters };
  results.push(r);
  console.log(`seed ${seed}: sequential ${(sequentialMs / 1000).toFixed(1)} s; speculative batches ${compared}, mismatched ${mismatches} (${(r.recomputeRate * 100).toFixed(0)}% recompute), max Δ ${maxDelta.toFixed(3)} units, extra work ${(specMs / 1000).toFixed(1)} s`);
  auth.free();
}
const out = opt("--out", "");
if (out) { const { writeFileSync } = await import("node:fs"); writeFileSync(out, JSON.stringify({ threshold, results }, null, 2)); console.log(`wrote ${out}`); }
