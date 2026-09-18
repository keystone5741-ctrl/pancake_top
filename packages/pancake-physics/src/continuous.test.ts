import { beforeAll, describe, expect, it } from "vitest";
import RAPIER from "@dimforge/rapier3d-compat";
import { ContinuousDropSimulator } from "./continuous";
import { HeightBandSurfaceProvider, TopNSurfaceProvider } from "./surface";
import { TowerSim } from "./TowerSim";
import { PRESETS } from "./types";

beforeAll(async () => { await RAPIER.init(); });

function baseTower(n: number) {
  const sim = new TowerSim(RAPIER, n, { ...PRESETS.natural, seed: 11 });
  while (sim.spawned < n || sim.batchInFlight) { if (!sim.batchInFlight) sim.queueBatch(Math.min(500, n - sim.spawned)); sim.step(); }
  const snap = sim.snapshot();
  sim.free();
  return snap;
}

describe("ContinuousDropSimulator", () => {
  it("walks a drop through OPEN → SIMULATING → CLOSING/FINALIZING → READY → RELEASED", () => {
    const base = baseTower(200);
    const c = new ContinuousDropSimulator(RAPIER, { capacity: 200 + 100, base, config: { ...PRESETS.natural, seed: 5 } });
    expect(c.baseCount).toBe(200);
    expect(c.surfaceColliderCount).toBe(64);
    const d = c.createDrop("DROP_A");
    expect(d.state).toBe("OPEN");
    expect(d.startSerial).toBe(200);
    const r1 = c.enqueuePancakes("DROP_A", 30);
    expect(r1).toEqual({ startSerial: 200, endSerial: 229 });
    expect(c.get("DROP_A")!.state).toBe("SIMULATING");
    const r2 = c.enqueuePancakes("DROP_A", 20);
    expect(r2).toEqual({ startSerial: 230, endSerial: 249 });
    // 구매가 들어오는 동안 계속 계산
    let guard = 0;
    while (c.processPending(2).pending && guard++ < 10000) { /* keep simulating */ }
    const closed = c.closeDrop("DROP_A");
    expect(["CLOSING", "FINALIZING", "READY"]).toContain(closed.state);
    const ready = c.finalizeDrop("DROP_A");
    expect(ready.state).toBe("READY");
    expect(ready.settled).toBe(50);
    expect(ready.heightAfter!).toBeGreaterThan(ready.heightBefore + 0.1 * 45);
    expect(() => c.enqueuePancakes("DROP_A", 1)).toThrow();
    expect(() => c.getDropResult("DROP_B")).toThrow();
    const res = c.getDropResult("DROP_A");
    expect(res.total).toBe(50);
    expect(res.finalTransforms.count).toBe(50);
    expect(res.finalTransforms.startSerial).toBe(200);
    expect(res.finalTransforms.py[0]).toBeGreaterThan(base.py[199] - 1);
    expect(res.heightAfter).toBe(ready.heightAfter);
    expect(c.releaseDrop("DROP_A").state).toBe("RELEASED");
    expect(() => c.releaseDrop("DROP_A")).toThrow();
    c.free();
  });

  it("routes purchases after cutoff to the next drop and stacks drops in order", () => {
    const base = baseTower(100);
    const c = new ContinuousDropSimulator(RAPIER, { capacity: 100 + 80, base, config: { ...PRESETS.natural, seed: 9 } });
    c.createDrop("D1");
    c.enqueuePancakes("D1", 30);
    expect(() => c.createDrop("D2")).toThrow(); // D1 이 아직 열려 있음
    c.closeDrop("D1");
    const d2 = c.createDrop("D2");
    expect(d2.startSerial).toBe(130);
    c.enqueuePancakes("D2", 20);
    c.finalizeDrop("D1");
    expect(c.get("D1")!.state).toBe("READY");
    c.finalizeDrop("D2");
    const r1 = c.getDropResult("D1"), r2 = c.getDropResult("D2");
    expect(r2.startSerial).toBe(r1.endSerial + 1);
    expect(r2.heightBefore).toBeGreaterThanOrEqual(r1.heightBefore);
    expect(r2.heightAfter).toBeGreaterThan(r1.heightAfter);
    expect(c.towerSnapshot().count).toBe(150);
    c.free();
  });

  it("finalize with nothing enqueued is READY immediately and the base is untouched", () => {
    const base = baseTower(120);
    const c = new ContinuousDropSimulator(RAPIER, { capacity: 200, base, config: { ...PRESETS.natural } });
    c.createDrop("E");
    expect(c.finalizeDrop("E").state).toBe("READY");
    const snap = c.towerSnapshot();
    for (let i = 0; i < 120; i += 13) expect(snap.py[i]).toBe(base.py[i]);
    c.free();
  });
});

describe("SurfaceColliderProvider", () => {
  it("top-N returns the N highest and the band provider returns everything within depth", () => {
    const base = baseTower(150);
    const top = new TopNSurfaceProvider(10).getSurfaceColliders(base);
    expect(top.length).toBe(10);
    const ys = top.map((i) => base.py[i]);
    for (let i = 1; i < ys.length; i++) expect(ys[i]).toBeLessThanOrEqual(ys[i - 1]);
    const band = new HeightBandSurfaceProvider(0.5).getSurfaceColliders(base);
    expect(band.length).toBeGreaterThanOrEqual(4);
    expect(band.length).toBeLessThanOrEqual(8);
    // provider 를 바꿔도 물리 규칙은 같다: band 로 loadBase 해도 새 Drop 이 정상 정착
    const c = new ContinuousDropSimulator(RAPIER, { capacity: 200, base, surfaceProvider: new HeightBandSurfaceProvider(1.0), config: { ...PRESETS.natural } });
    expect(c.surfaceColliderCount).toBe(new HeightBandSurfaceProvider(1.0).getSurfaceColliders(base).length);
    c.createDrop("F"); c.enqueuePancakes("F", 20);
    expect(c.finalizeDrop("F").settled).toBe(20);
    c.free();
  });
});
