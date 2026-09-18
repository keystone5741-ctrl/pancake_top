import { describe, expect, it } from "vitest";
import { DEFAULT_TOWER_CONFIG, MemoryChunkSource, Tower, chunkIdOf, instanceIndexOf, serialOf, generateSyntheticTower, projectedDiameterPx, distanceForProjectedPx, boundsIntersectsFrustum, decideChunkStates, estimateInstanceBytes, type FrustumPlanes } from "./index";

const cfg = { ...DEFAULT_TOWER_CONFIG, chunkSize: 1000 };

function tower(n: number): Tower {
  return new Tower(new MemoryChunkSource(generateSyntheticTower(n, cfg, 7), cfg));
}

/** 카메라가 +z 에서 -z 를 보는 간단한 절두체 (near/far 만 평면으로) */
function frustumLookingAt(zNear: number, zFar: number): FrustumPlanes {
  return [
    { normal: [0, 0, -1], constant: zNear },   // z <= zNear
    { normal: [0, 0, 1], constant: -zFar },    // z >= zFar
  ];
}

describe("chunk arithmetic", () => {
  it("maps serial → chunk → instance and back", () => {
    expect(chunkIdOf(0, 1000)).toBe(0);
    expect(chunkIdOf(999, 1000)).toBe(0);
    expect(chunkIdOf(1000, 1000)).toBe(1);
    expect(instanceIndexOf(54321, 10000)).toBe(4321);
    expect(chunkIdOf(54321, 10000)).toBe(5);
    expect(serialOf(5, 4321, 10000)).toBe(54321);
  });
});

describe("Tower", () => {
  it("splits a transform set into chunks with correct serial ranges, counts and bounds", () => {
    const t = tower(2500);
    expect(t.count).toBe(2500);
    expect(t.chunkCount).toBe(3);
    expect(t.headers.map((h) => [h.startSerial, h.endSerial, h.count])).toEqual([[0, 999, 1000], [1000, 1999, 1000], [2000, 2499, 500]]);
    for (const h of t.headers) {
      expect(h.bounds.min[1]).toBeLessThanOrEqual(h.minHeight);
      expect(h.maxHeight).toBeGreaterThan(h.minHeight);
      expect(h.bounds.max[0] - h.bounds.min[0]).toBeGreaterThan(1); // 최소 지름
    }
    // 위 chunk 는 더 높다 (경계에서 기울기 여유만큼만 겹칠 수 있다)
    expect(t.headers[1].minHeight).toBeGreaterThan(t.headers[0].maxHeight - 0.2);
  });

  it("height comes from chunk headers without loading transforms and equals the tallest pancake top", () => {
    const set = generateSyntheticTower(2500, cfg, 7);
    const t = new Tower(new MemoryChunkSource(set, cfg));
    let top = 0;
    for (let i = 0; i < set.count; i++) {
      const uy = Math.abs(1 - 2 * (set.qx[i] ** 2 + set.qz[i] ** 2));
      const r = (cfg.diameter * set.scale[i]) / 2, h = (cfg.thickness * set.tscale[i]) / 2;
      top = Math.max(top, set.py[i] + r * Math.sqrt(1 - uy * uy) + h * uy);
    }
    expect(t.loadedChunkCount).toBe(0);
    // header 의 maxHeight = 기울어진 원기둥 윗면 가장자리의 정확한 최고점
    expect(t.height).toBeCloseTo(top, 6);
    expect(t.heightMeters).toBeCloseTo((t.height * cfg.unitCm) / 100, 9);
  });

  it("findPancake: first, middle, last and invalid", () => {
    const set = generateSyntheticTower(2500, cfg, 7);
    const t = new Tower(new MemoryChunkSource(set, cfg));
    for (const id of [0, 1234, 2499]) {
      const r = t.findPancake(id)!;
      expect(r).not.toBeNull();
      expect(r.chunkId).toBe(Math.floor(id / 1000));
      expect(r.instanceIndex).toBe(id % 1000);
      expect(r.worldPosition).toEqual([set.px[id], set.py[id], set.pz[id]]);
      expect(r.transform.quaternion[3]).toBe(set.qw[id]);
      expect(r.metadata.country).toBe("ZZ");
    }
    expect(t.findPancake(2500)).toBeNull();
    expect(t.findPancake(-1)).toBeNull();
    expect(t.findPancake(1.5)).toBeNull();
    expect(t.state(1)).toBe("CPU_READY"); // 조회로 로드됨
  });

  it("findPancakeAsync loads the chunk through the source", async () => {
    const t = tower(2500);
    expect(t.state(2)).toBe("UNLOADED");
    const r = await t.findPancakeAsync(2400);
    expect(r?.chunkId).toBe(2);
    expect(t.state(2)).toBe("CPU_READY");
    expect(await t.findPancakeAsync(99999)).toBeNull();
  });

  it("selects visible chunks by frustum against chunk bounds", () => {
    const t = tower(2500);
    const all = t.visibleChunkIds(frustumLookingAt(10, -10));
    expect(all).toEqual([0, 1, 2]);
    const none = t.visibleChunkIds(frustumLookingAt(50, 40));
    expect(none).toEqual([]);
  });

  it("state transitions require loaded transforms except UNLOADED", () => {
    const t = tower(1500);
    expect(() => t.setState(0, "GPU_LOW")).toThrow();
    t.loadChunkSync(0);
    t.setState(0, "GPU_HIGH");
    expect(t.state(0)).toBe("GPU_HIGH");
    t.unloadChunk(0);
    expect(t.state(0)).toBe("UNLOADED");
  });
});

describe("projection / streaming", () => {
  const vp = { fovY: (50 * Math.PI) / 180, heightPx: 800 };
  it("projected diameter and its inverse agree", () => {
    const d = distanceForProjectedPx(20, 1, vp);
    expect(projectedDiameterPx(d, 1, vp)).toBeCloseTo(20, 9);
    expect(projectedDiameterPx(5300, 1, vp)).toBeCloseTo(0.162, 2); // Phase 0.75 전체 뷰 계산과 일치 (FOV 50°, 800 px)
  });
  it("frustum test is conservative on partially inside boxes", () => {
    const b = { min: [-1, -1, -1] as [number, number, number], max: [1, 1, 1] as [number, number, number] };
    expect(boundsIntersectsFrustum(b, frustumLookingAt(0.5, -5))).toBe(true);
    expect(boundsIntersectsFrustum(b, frustumLookingAt(5, 2))).toBe(false);
  });
  it("decides GPU_HIGH near, GPU_LOW far, CPU_READY prefetch, UNLOADED beyond", () => {
    const t = tower(2500);
    const near = decideChunkStates(t.headers, { position: [3, 5, 0], frustum: frustumLookingAt(10, -10), viewport: vp }, cfg.diameter);
    expect(near.find((d) => d.id === 0)!.desired).toBe("GPU_HIGH");
    const far = decideChunkStates(t.headers, { position: [0, 5, 3000], frustum: frustumLookingAt(4000, -10), viewport: vp }, cfg.diameter);
    expect(far.every((d) => d.desired === "GPU_LOW")).toBe(true);
    const out = decideChunkStates(t.headers, { position: [0, 5, 3000], frustum: frustumLookingAt(50, 40), viewport: vp }, cfg.diameter, { highLodMinPx: 4, prefetchDistanceFactor: 2, keepGpuDistance: 2000 });
    expect(out.every((d) => d.desired === "CPU_READY")).toBe(true);
    const gone = decideChunkStates(t.headers, { position: [0, 5, 3000], frustum: frustumLookingAt(50, 40), viewport: vp }, cfg.diameter, { highLodMinPx: 4, prefetchDistanceFactor: 1.1, keepGpuDistance: 100 });
    expect(gone.every((d) => d.desired === "UNLOADED")).toBe(true);
  });
  it("estimates instance memory", () => {
    expect(estimateInstanceBytes(1_000_000)).toBe(76_000_000);
  });
});
