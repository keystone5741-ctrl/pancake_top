import { beforeAll, describe, expect, it } from "vitest";
import RAPIER from "@dimforge/rapier3d-compat";
import { TowerSim } from "./TowerSim";
import { PRESETS, STATE_ACTIVE, STATE_FROZEN, STATE_SURFACE, type SimConfig } from "./types";

beforeAll(async () => { await RAPIER.init(); });

function build(n: number, cfg: Partial<SimConfig> = {}): TowerSim {
  const sim = new TowerSim(RAPIER, n, { ...PRESETS.natural, ...cfg });
  let guard = 0;
  while (sim.spawned < n || sim.batchInFlight) {
    if (!sim.batchInFlight && sim.spawned < n) sim.queueBatch(Math.min(sim.cfg.batchSize, n - sim.spawned));
    sim.step();
    if (++guard > 200000) throw new Error("did not settle");
  }
  return sim;
}

describe("TowerSim stacking (natural preset)", () => {
  it("stacks 300 pancakes upward with no leaks, no ground penetration and no severe overlap", () => {
    const sim = build(300);
    const m = sim.metrics();
    expect(sim.spawned).toBe(300);
    expect(sim.activeCount).toBe(0);
    expect(sim.leakCount).toBe(0);
    expect(sim.surfaceCount + sim.frozen).toBe(300);
    expect(m.belowGround).toBe(0);
    expect(m.nonFinite).toBe(0);
    expect(m.height.efficiency).toBeGreaterThan(0.9);
    expect(m.height.efficiency).toBeLessThan(1.15);
    // Phase 0.5 수용 기준: 심각한 침투(두께의 50% 이상) 없음, p95 는 20% 이하.
    // 기울기 변화가 있는 강체 원반은 가장자리 접촉이 소량의 겹침으로 잡히는 것이 정상이다.
    expect(m.penetration.max).toBeLessThan(0.5);
    expect(m.penetration.p95).toBeLessThan(0.2);
    expect(m.spread.max).toBeLessThan(0.2); // m
    sim.free();
  });

  it("keeps only exposed pancakes as SURFACE colliders (frozen architecture)", () => {
    const sim = build(500);
    expect(sim.surfaceCount).toBeLessThan(30);
    expect(sim.frozen).toBeGreaterThan(450);
    let surface = 0, frozen = 0, active = 0;
    for (let i = 0; i < sim.spawned; i++) {
      if (sim.state[i] === STATE_SURFACE) surface++;
      else if (sim.state[i] === STATE_FROZEN) frozen++;
      else if (sim.state[i] === STATE_ACTIVE) active++;
    }
    expect([active, surface, frozen]).toEqual([0, sim.surfaceCount, sim.frozen]);
    sim.free();
  });

  it("is deterministic for the same seed", () => {
    const a = build(150, { seed: 5 });
    const b = build(150, { seed: 5 });
    expect(Array.from(a.py)).toEqual(Array.from(b.py));
    expect(Array.from(a.qw)).toEqual(Array.from(b.qw));
    const c = build(150, { seed: 6 });
    expect(Array.from(c.py)).not.toEqual(Array.from(a.py));
    a.free(); b.free(); c.free();
  });

  it("varies size, thickness and yaw per pancake", () => {
    const sim = build(100);
    const scales = new Set(Array.from(sim.scale).map((v) => v.toFixed(3)));
    const tscales = new Set(Array.from(sim.tscale).map((v) => v.toFixed(3)));
    expect(scales.size).toBeGreaterThan(20);
    expect(tscales.size).toBeGreaterThan(20);
    expect(Math.abs(Array.from(sim.scale).reduce((s, v) => s + v, 0) / 100 - 1)).toBeLessThan(0.02);
    sim.free();
  });

  it("snapshot only carries server-side data and matches the live arrays", () => {
    const sim = build(50);
    const s = sim.snapshot();
    expect(s.count).toBe(50);
    expect(Object.keys(s).sort()).toEqual(["count", "diameter", "px", "py", "pz", "qw", "qx", "qy", "qz", "scale", "thickness", "tscale", "unitCm"]);
    expect(s.py[10]).toBe(sim.py[10]);
    sim.free();
  });

  // Release(붕괴) 경로는 Phase 0.5 범위 밖이다. Phase 0 스트레스 테스트 결과로만 보존하며, Rapier 0.20 이 간헐적으로
  // 패닉(unreachable)을 일으키는 문제는 정상 Drop 경로에서 재현되지 않는 한 조사하지 않는다 (phase0.5 문서 미해결 리스크).
});
