import { describe, expect, it } from "vitest";
import { QUALITY_PRESETS, QualityManager, lodForProjectedPx, recommendPreset } from "./quality";

describe("LOD selection by projected size", () => {
  const t = QUALITY_PRESETS.standard.lodThresholdsPx; // 20 / 4
  it("picks LOD0 above lod0 px, LOD1 between, LOD2 below", () => {
    expect(lodForProjectedPx(25, t)).toBe(0);
    expect(lodForProjectedPx(20, t)).toBe(0);
    expect(lodForProjectedPx(19.9, t)).toBe(1);
    expect(lodForProjectedPx(4, t)).toBe(1);
    expect(lodForProjectedPx(3.9, t)).toBe(2);
    expect(lodForProjectedPx(0.11, t)).toBe(2);
  });
  it("presets keep thresholds ordered", () => {
    for (const p of Object.values(QUALITY_PRESETS)) expect(p.lodThresholdsPx.lod0).toBeGreaterThan(p.lodThresholdsPx.lod1);
  });
});

describe("QualityManager", () => {
  it("switches presets and notifies once per change", () => {
    const qm = new QualityManager("standard");
    let n = 0;
    qm.onChange(() => n++);
    qm.setPreset("standard");
    qm.setPreset("ultra");
    qm.setPreset("ultra");
    expect(n).toBe(1);
    expect(qm.current.name).toBe("ultra");
  });
  it("recommends from measured p95 first, then device hints", () => {
    expect(recommendPreset({ measuredP95Ms: 10 })).toBe("ultra");
    expect(recommendPreset({ measuredP95Ms: 10, mobile: true })).toBe("standard");
    expect(recommendPreset({ measuredP95Ms: 25 })).toBe("standard");
    expect(recommendPreset({ measuredP95Ms: 50 })).toBe("performance");
    expect(recommendPreset({ mobile: true })).toBe("performance");
    expect(recommendPreset({ gpuRenderer: "SwiftShader" })).toBe("performance");
    expect(recommendPreset({ gpuRenderer: "NVIDIA GeForce RTX 3060" })).toBe("standard");
    const qm = new QualityManager();
    qm.updateMetrics({ frameMsP95: 15 });
    expect(qm.recommendPreset({ mobile: false })).toBe("ultra");
  });
});
