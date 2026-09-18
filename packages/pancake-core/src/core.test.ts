import { describe, expect, it } from "vitest";
import { decodeCountry, encodeCountry, formatHeight, metersToWorldUnits, milestoneProgress, worldUnitsToMeters, HEIGHT_MILESTONES } from "./index";

describe("units", () => {
  it("converts world units and meters both ways (1 unit = 10 cm)", () => {
    expect(worldUnitsToMeters(10)).toBe(1);
    expect(metersToWorldUnits(1)).toBe(10);
    expect(worldUnitsToMeters(metersToWorldUnits(1013.5))).toBeCloseTo(1013.5, 9);
    expect(worldUnitsToMeters(1, 100)).toBe(1);
  });
  it("formats heights by magnitude", () => {
    expect(formatHeight(0)).toBe("0 m");
    expect(formatHeight(1.234)).toBe("1.23 m");
    expect(formatHeight(123.6)).toBe("124 m");
    expect(formatHeight(1013.5)).toBe("1.01 km");
    expect(formatHeight(82470)).toBe("82.47 km");
    expect(formatHeight(384400000)).toBe("384,400 km");
  });
});

describe("country codes", () => {
  it("round-trips ISO alpha-2 codes through uint16", () => {
    for (const c of ["KR", "JP", "US", "BR", "AA", "ZZ"]) expect(decodeCountry(encodeCountry(c))).toBe(c);
    expect(decodeCountry(encodeCountry("??"))).toBe("ZZ");
    expect(decodeCountry(9999)).toBe("ZZ");
  });
});

describe("milestones", () => {
  it("reports reached, next and progress from the same height value", () => {
    const p = milestoneProgress(1013.5);
    expect(p.reached.map((m) => m.id)).toEqual(["building", "eiffel", "burj"]);
    expect(p.next?.id).toBe("everest");
    expect(p.remainingMeters).toBeCloseTo(8849 - 1013.5, 6);
    expect(p.progress).toBeCloseTo((1013.5 - 828) / (8849 - 828), 6);
  });
  it("handles below first and beyond last", () => {
    expect(milestoneProgress(0).next?.id).toBe("building");
    expect(milestoneProgress(0).progress).toBe(0);
    const last = milestoneProgress(HEIGHT_MILESTONES[HEIGHT_MILESTONES.length - 1].meters + 1);
    expect(last.next).toBeNull();
    expect(last.progress).toBe(1);
  });
});
