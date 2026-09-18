import { describe, expect, it } from "vitest";
import { altitudeStops } from "./altitude";
import { altitudeViewpoint, findViewpoint, flightAt, flightDuration, fullTowerViewpoint, topViewpoint } from "./flight";

describe("flight", () => {
  it("ends exactly at the destination and starts at the origin", () => {
    const plan = { fromPos: [10, 5, 10] as [number, number, number], fromTarget: [0, 1, 0] as [number, number, number], toPos: [2, 100, 2] as [number, number, number], toTarget: [0, 99, 0] as [number, number, number], durationMs: 1000 };
    expect(flightAt(plan, 0).pos).toEqual([10, 5, 10]);
    expect(flightAt(plan, 1).pos).toEqual([2, 100, 2]);
    expect(flightAt(plan, 1.5).target).toEqual([0, 99, 0]);
    const mid = flightAt(plan, 0.5);
    expect(mid.pos[1]).toBeGreaterThan(52.5); // 포물선으로 살짝 위
  });
  it("duration grows with distance, is capped, and is zero for reduced motion", () => {
    expect(flightDuration([0, 0, 0], [0, 0, 0], false)).toBe(600);
    expect(flightDuration([0, 0, 0], [0, 1000, 0], false)).toBeGreaterThan(flightDuration([0, 0, 0], [0, 10, 0], false));
    expect(flightDuration([0, 0, 0], [0, 1e9, 0], false)).toBe(3500);
    expect(flightDuration([0, 0, 0], [0, 1e9, 0], true)).toBe(0);
  });
  it("find viewpoint looks at the pancake from a few diameters away", () => {
    const v = findViewpoint([1, 500, 2], 1);
    expect(v.target).toEqual([1, 500, 2]);
    const d = Math.hypot(v.pos[0] - 1, v.pos[1] - 500, v.pos[2] - 2);
    expect(d).toBeGreaterThan(3);
    expect(d).toBeLessThan(4.5);
    expect(v.pos[1]).toBeGreaterThan(500);
  });
  it("full tower viewpoint fits the whole height in the vertical FOV", () => {
    const fov = (50 * Math.PI) / 180;
    const v = fullTowerViewpoint(10000, fov, 1.6);
    const d = Math.hypot(v.pos[0], v.pos[2]);
    const halfVisible = d * Math.tan(fov / 2);
    expect(halfVisible).toBeGreaterThanOrEqual(5000);
    expect(v.target[1]).toBe(5000);
    expect(topViewpoint(10000, 1).target[1]).toBe(10000);
    expect(altitudeViewpoint(50000, 10000, 1).target[1]).toBeLessThanOrEqual(10002);
  });
});

describe("altitude navigator", () => {
  it("lists ground, decades, milestones up to the next one, and the tower itself", () => {
    const a = altitudeStops(1013.5);
    const labels = a.stops.map((s) => s.label);
    expect(labels[0]).toBe("GROUND");
    expect(labels).toContain("1.00 km");
    expect(labels).toContain("Mount Everest");
    expect(labels.some((l) => l.startsWith("TOWER"))).toBe(true);
    expect(labels).not.toContain("SPACE (Kármán line)");
    expect(a.position(0)).toBe(0);
    expect(a.position(a.maxMeters)).toBeCloseTo(1, 9);
    for (let i = 1; i < a.stops.length; i++) expect(a.stops[i].meters).toBeGreaterThan(a.stops[i - 1].meters);
  });
});
