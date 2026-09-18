import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { DEFAULT_TOWER_CONFIG, MemoryChunkSource, Tower, generateSyntheticTower } from "tower-engine";
import { ChunkRenderer } from "./chunkRenderer";
import { DropReplay, replayLocalProgress, replayPose } from "./dropReplay";
import { QualityManager } from "./quality";

describe("replay math", () => {
  const final = { p: [1, 50, 2] as [number, number, number], q: [0.1, 0.2, 0.3, 0.927] as [number, number, number, number] };
  const start = { p: [1, 80, 2] as [number, number, number], q: final.q };
  it("returns the exact final pose at local >= 1 and the start at 0", () => {
    expect(replayPose(final, start, 1, 3, 0)).toEqual(final);
    expect(replayPose(final, start, 1.7, 3, 0).p).toEqual(final.p);
    expect(replayPose(final, start, 0, 3, 0).p).toEqual(start.p);
  });
  it("descends monotonically and is deterministic per seed", () => {
    let prev = Infinity;
    for (let t = 0; t <= 1; t += 0.05) { const y = replayPose(final, start, t, 3, 0).p[1]; expect(y).toBeLessThanOrEqual(prev + 1e-9); prev = y; }
    expect(replayPose(final, start, 0.4, 3, 5)).toEqual(replayPose(final, start, 0.4, 3, 5));
    expect(replayPose(final, start, 0.4, 3, 5).q).not.toEqual(replayPose(final, start, 0.4, 4, 5).q);
  });
  it("staggers later pancakes", () => {
    expect(replayLocalProgress(0, 10, 0.5, 0.3)).toBeGreaterThan(replayLocalProgress(9, 10, 0.5, 0.3));
    expect(replayLocalProgress(9, 10, 1, 0.3)).toBe(1);
    expect(replayLocalProgress(0, 1, 0.2, 0.3)).toBeCloseTo(0.26, 9);
  });
});

describe("DropReplay convergence (regression from Phase 0.75)", () => {
  it("render matrices equal the server final transforms after the replay", () => {
    const cfg = { ...DEFAULT_TOWER_CONFIG, chunkSize: 500 };
    const set = generateSyntheticTower(1200, cfg, 9);
    const tower = new Tower(new MemoryChunkSource(set, cfg));
    const renderer = new ChunkRenderer(tower, new QualityManager("performance"));
    const camera = new THREE.PerspectiveCamera(50, 1.6, 0.1, 10000);
    camera.position.set(3, 110, 3); camera.lookAt(0, 105, 0);
    renderer.update(camera, 800);
    const replay = new DropReplay(tower, renderer, 700, 1199, { durationMs: 1000, dropHeight: 30, stagger: 0.3, seed: 1 });
    let now = 0;
    replay.update(now);
    // 중간: 렌더 위치가 final 보다 위에 있어야 한다
    now = 300; replay.update(now);
    const m = new THREE.Matrix4(), p = new THREE.Vector3();
    renderer.readInstanceMatrix(tower.chunkIdOf(1199), 1199 - tower.chunkIdOf(1199) * 500, m);
    expect(p.setFromMatrixPosition(m).y).toBeGreaterThan(set.py[1199] + 1);
    now = 1000; expect(replay.update(now)).toBe(true);
    const r = replay.result!;
    expect(r.animated).toBe(500);
    expect(r.maxPosError).toBe(0);
    expect(r.maxQuatError).toBeLessThan(1e-6);
    expect(r.converged).toBe(true);
    // 서버 배열도 원래 값 그대로
    for (const id of [700, 950, 1199]) expect(tower.findPancake(id)!.worldPosition).toEqual([set.px[id], set.py[id], set.pz[id]]);
    renderer.dispose();
  });
});
