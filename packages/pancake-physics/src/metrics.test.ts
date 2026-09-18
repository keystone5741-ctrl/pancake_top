import { describe, expect, it } from "vitest";
import { computeStackingMetrics, quantile, tiltOf, type TowerSnapshot } from "./metrics";
import { decodeTower, encodeTower } from "./towerFile";
import type { TowerData } from "pancake-core";
import { createRng } from "./rng";

function column(n: number, opts: { gap?: number; tiltRad?: number; offset?: number } = {}): TowerData {
  const gap = opts.gap ?? 0.1;
  const mk = (): Float32Array => new Float32Array(n);
  const t: TowerData = { count: n, diameter: 1, thickness: 0.1, unitCm: 10, px: mk(), py: mk(), pz: mk(), qx: mk(), qy: mk(), qz: mk(), qw: mk(), scale: mk().fill(1), tscale: mk().fill(1) };
  for (let i = 0; i < n; i++) {
    t.px[i] = (opts.offset ?? 0) * i;
    t.py[i] = 0.05 + i * gap;
    const a = opts.tiltRad ?? 0;
    t.qx[i] = Math.sin(a / 2); t.qw[i] = Math.cos(a / 2);
  }
  return t;
}

describe("quantile / tiltOf", () => {
  it("quantile picks by position on a sorted array", () => {
    expect(quantile([1, 2, 3, 4, 5], 0.5)).toBe(3);
    expect(quantile([1, 2, 3, 4, 5], 0)).toBe(1);
    expect(quantile([1, 2, 3, 4, 5], 1)).toBe(5);
    expect(quantile([], 0.5)).toBe(0);
  });
  it("tiltOf is 0 for identity and the given angle for an X-axis rotation", () => {
    expect(tiltOf(0, 0, 0, 1)).toBeCloseTo(0, 6);
    const a = 0.3;
    expect(tiltOf(Math.sin(a / 2), 0, 0, Math.cos(a / 2))).toBeCloseTo(a, 6);
  });
});

describe("computeStackingMetrics", () => {
  it("treats a stack tilted about X as stacked along its own normal (0, cos a, sin a)", () => {
    const a = 0.4;
    const t = column(3, { tiltRad: a });
    for (let i = 0; i < 3; i++) { t.py[i] = 0.05 + i * 0.1 * Math.cos(a); t.pz[i] = i * 0.1 * Math.sin(a); }
    expect(computeStackingMetrics(t).penetration.overlappingPairs).toBe(0);
    // 반대 방향으로 쌓으면(잘못된 법선) 침투로 잡혀야 한다
    for (let i = 0; i < 3; i++) t.pz[i] = -i * 0.1 * Math.sin(a);
    expect(computeStackingMetrics(t).penetration.overlappingPairs).toBeGreaterThan(0);
  });
  it("perfect column: efficiency 1, no spread, no tilt, unit layer gaps, no penetration", () => {
    const m = computeStackingMetrics(column(100));
    expect(m.count).toBe(100);
    expect(m.height.efficiency).toBeCloseTo(1, 4);
    expect(m.height.towerM).toBeCloseTo(1.0, 4);
    expect(m.spread.max).toBe(0);
    expect(m.tilt.max).toBeCloseTo(0, 6);
    expect(m.layerSpacing.median).toBeCloseTo(1, 4);
    expect(m.layerSpacing.p05).toBeCloseTo(1, 4);
    expect(m.penetration.overlappingPairs).toBe(0);
    expect(m.belowGround).toBe(0);
  });
  it("splits height efficiency into nominal and geometry-normalized", () => {
    const t = column(10);
    // 두께 편차: 모든 팬케이크가 공칭보다 10% 두껍고 그만큼 높이 쌓였다면 nominal 110%, geometry 100%
    t.tscale.fill(1.1);
    for (let i = 0; i < 10; i++) t.py[i] = 0.055 + i * 0.11;
    const m = computeStackingMetrics(t);
    expect(m.height.efficiency).toBeCloseTo(1.1, 4);
    expect(m.height.geometryM).toBeCloseTo(0.11, 6);
    expect(m.height.geometryEfficiency).toBeCloseTo(1.0, 4);
  });
  it("reports tilt in degrees and spread in metres", () => {
    const m = computeStackingMetrics(column(10, { tiltRad: Math.PI / 18, offset: 0.1 }));
    expect(m.tilt.median).toBeCloseTo(10, 3);
    expect(m.spread.max).toBeCloseTo((0.9 * 10) / 100, 6);
  });
  it("detects interpenetration when layers are closer than the thickness", () => {
    const m = computeStackingMetrics(column(50, { gap: 0.08 }));
    expect(m.penetration.overlappingPairs).toBe(49);
    expect(m.penetration.max).toBeCloseTo(0.2, 3);
    expect(m.height.efficiency).toBeLessThan(0.85);
  });
  it("does not flag a uniformly tilted parallel stack as penetrating", () => {
    // 15도 기울어진 평행 스택: 중심 y 차이는 두께보다 작지만(법선 방향으로는 정확히 두께) 침투가 아니다
    const a = (15 * Math.PI) / 180;
    const t = column(30, { tiltRad: a });
    for (let i = 0; i < 30; i++) {
      // 법선 (0, cos a, -sin a)... X축 회전이므로 up = (0, cos a, sin a) 방향으로 두께만큼 이동
      t.py[i] = 0.05 + i * 0.1 * Math.cos(a);
      t.pz[i] = i * 0.1 * Math.sin(a);
    }
    const m = computeStackingMetrics(t);
    expect(m.penetration.overlappingPairs).toBe(0);
    expect(m.tilt.median).toBeCloseTo(15, 3);
  });
  it("counts pancakes below ground and ignores non-finite ones", () => {
    const t = column(5);
    t.py[0] = -0.3;
    t.px[1] = Number.NaN;
    const m = computeStackingMetrics(t);
    expect(m.belowGround).toBe(1);
    expect(m.nonFinite).toBe(1);
    expect(m.count).toBe(4);
  });
  it("honours the include filter", () => {
    const t: TowerSnapshot = { ...column(10), include: (id) => id < 3 };
    expect(computeStackingMetrics(t).count).toBe(3);
  });
});

describe("tower file", () => {
  it("round-trips through the PKT1 binary format", () => {
    const t = column(7, { tiltRad: 0.1, offset: 0.02 });
    t.scale[3] = 1.04; t.tscale[5] = 0.93;
    const d = decodeTower(encodeTower(t), 10);
    expect(d.count).toBe(7);
    expect(d.diameter).toBe(1);
    expect(d.thickness).toBeCloseTo(0.1, 6);
    for (const k of ["px", "py", "pz", "qx", "qy", "qz", "qw", "scale", "tscale"] as const) {
      expect(Array.from(d[k])).toEqual(Array.from(t[k]));
    }
  });
  it("rejects a foreign buffer", () => {
    expect(() => decodeTower(new ArrayBuffer(32))).toThrow();
  });
});

describe("rng", () => {
  it("is deterministic per seed and in [0,1)", () => {
    const a = createRng(7), b = createRng(7), c = createRng(8);
    const xs = Array.from({ length: 5 }, () => a());
    expect(Array.from({ length: 5 }, () => b())).toEqual(xs);
    expect(Array.from({ length: 5 }, () => c())).not.toEqual(xs);
    for (const x of xs) { expect(x).toBeGreaterThanOrEqual(0); expect(x).toBeLessThan(1); }
  });
});
