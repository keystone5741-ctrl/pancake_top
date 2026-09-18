import { describe, expect, it } from "vitest";
import { DEFAULT_TOWER_CONFIG, MemoryChunkSource, Tower, generateSyntheticTower } from "tower-engine";
import { buildScaleModel, renderScaleSvg } from "./heightScale";

describe("height scale visualization", () => {
  it("uses the tower height it is given as the single value for the tower mark", () => {
    const cfg = { ...DEFAULT_TOWER_CONFIG, chunkSize: 1000 };
    const tower = new Tower(new MemoryChunkSource(generateSyntheticTower(5000, cfg, 3), cfg));
    const model = buildScaleModel(tower.heightMeters);
    const towerMark = model.marks.find((m) => m.kind === "tower")!;
    expect(towerMark.meters).toBe(tower.heightMeters);
    expect(model.towerMeters).toBe(tower.heightMeters);
    // 마크는 높이 순, y 는 단조 증가, SPACE 는 항상 포함
    for (let i = 1; i < model.marks.length; i++) { expect(model.marks[i].meters).toBeGreaterThanOrEqual(model.marks[i - 1].meters); expect(model.marks[i].y).toBeGreaterThanOrEqual(model.marks[i - 1].y); }
    expect(model.marks.some((m) => m.label.startsWith("SPACE"))).toBe(true);
    expect(model.y(0)).toBe(0);
    expect(model.y(model.maxMeters)).toBeCloseTo(1, 9);
    const svg = renderScaleSvg(model, 800, 600);
    expect(svg).toContain("PANCAKE TOWER");
    expect(svg).toContain("HEIGHT MODE");
  });
});
