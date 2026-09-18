import { describe, expect, it } from "vitest";
import { DropScheduler } from "../src/drops/scheduler";
import { acceptsPurchases, assertTransition, canTransition, type DropStatus } from "../src/drops/coordinator";

describe("DropScheduler", () => {
  const s = new DropScheduler(600, 60);
  it("derives deterministic ids from UTC boundaries", () => {
    const t = new Date("2026-09-18T03:07:12.345Z");
    const slot = s.currentDrop(t);
    expect(slot.dropId).toBe("drop_20260918T031000Z");
    expect(slot.scheduledAt.toISOString()).toBe("2026-09-18T03:10:00.000Z");
    expect(slot.cutoffAt.toISOString()).toBe("2026-09-18T03:09:00.000Z");
    expect(DropScheduler.parseId(slot.dropId)?.toISOString()).toBe("2026-09-18T03:10:00.000Z");
    expect(DropScheduler.parseId("nope")).toBeNull();
    // 같은 시각이면 재시작 후에도 같은 id
    expect(new DropScheduler(600, 60).currentDrop(new Date("2026-09-18T03:07:12.345Z")).dropId).toBe(slot.dropId);
  });
  it("moves purchases after the cutoff to the next drop", () => {
    expect(s.currentDrop(new Date("2026-09-18T03:08:59.999Z")).dropId).toBe("drop_20260918T031000Z");
    expect(s.currentDrop(new Date("2026-09-18T03:09:00.000Z")).dropId).toBe("drop_20260918T032000Z");
    expect(s.currentDrop(new Date("2026-09-18T03:10:00.000Z")).dropId).toBe("drop_20260918T032000Z");
    expect(s.currentDrop(new Date("2026-09-18T03:59:30.000Z")).dropId).toBe("drop_20260918T041000Z");
    expect(s.after(s.currentDrop(new Date("2026-09-18T03:00:00.000Z"))).dropId).toBe("drop_20260918T032000Z");
  });
  it("rejects a cutoff longer than the interval", () => {
    expect(() => new DropScheduler(60, 60)).toThrow();
  });
});

describe("Drop state transitions", () => {
  const all: DropStatus[] = ["OPEN", "SIMULATING", "CLOSING", "FINALIZING", "READY", "RELEASED", "FAILED"];
  it("allows the documented transitions only", () => {
    const valid: [DropStatus, DropStatus][] = [["OPEN", "SIMULATING"], ["OPEN", "CLOSING"], ["SIMULATING", "CLOSING"], ["CLOSING", "FINALIZING"], ["CLOSING", "READY"], ["FINALIZING", "READY"], ["READY", "RELEASED"], ["OPEN", "FAILED"], ["SIMULATING", "FAILED"], ["CLOSING", "FAILED"], ["FINALIZING", "FAILED"], ["READY", "FAILED"], ["FAILED", "FINALIZING"]];
    for (const [a, b] of valid) expect(canTransition(a, b), `${a}→${b}`).toBe(true);
    for (const a of all) for (const b of all) {
      const isValid = valid.some(([x, y]) => x === a && y === b);
      expect(canTransition(a, b), `${a}→${b}`).toBe(isValid);
    }
    expect(() => assertTransition("d", "RELEASED", "OPEN")).toThrow(/invalid transition/);
    expect(() => assertTransition("d", "READY", "SIMULATING")).toThrow();
    expect(() => assertTransition("d", "FAILED", "READY")).toThrow();
    expect(acceptsPurchases("OPEN")).toBe(true);
    expect(acceptsPurchases("CLOSING")).toBe(false);
  });
});
