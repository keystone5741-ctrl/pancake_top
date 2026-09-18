import { afterAll, describe, expect, it } from "vitest";
import { decodeTower } from "pancake-physics";
const dec = (b: Uint8Array) => decodeTower(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);
import { SimulationWorkerClient, WorkerCrashError } from "../src/sim/workerClient";

const client = new SimulationWorkerClient({ config: { seed: 4242 }, capacity: 5000, surfaceTopN: 64, surfaceSliceSize: 128 });
afterAll(async () => { await client.stop(); });

describe("simulation worker isolation", () => {
  it("simulates in a child process and returns transforms, surface and metrics", async () => {
    const init = await client.ensure(null);
    expect(init.spawned).toBe(0);
    const r = await client.simulate("job-1", 120, 1);
    expect(r.spawned).toBe(120);
    const t = dec(r.finalTransforms);
    expect(t.count).toBe(120);
    expect(r.heightUnits).toBeGreaterThan(10);
    expect(r.metrics.leaks).toBe(0);
    const surf = dec(r.surfaceAfter);
    expect(surf.count).toBe(120); // 128 슬라이스 > 120
    // 이어서 쌓기: serial 이 계속된다
    const r2 = await client.simulate("job-2", 30, 2);
    expect(r2.spawned).toBe(150);
    expect(r2.heightUnits).toBeGreaterThan(r.heightUnits);
  });

  it("survives a worker crash: pending job rejected, main alive, new worker resumes from the surface", async () => {
    const snap = await client.snapshot();
    const crashes = client.crashes;
    // worker 는 메시지를 순서대로 처리한다: 먼저 죽으라는 메시지, 그 뒤의 job 은 처리되지 못하고 거부된다
    client.devCrash();
    const p = client.simulate("job-3", 200, 3);
    await expect(p).rejects.toBeInstanceOf(WorkerCrashError);
    expect(client.alive).toBe(false);
    expect(client.crashes).toBe(crashes + 1);
    // 마지막 안전 surface 로 재시작
    // 새 worker 의 base 는 surface 슬라이스(상위 128장)뿐이다. 전역 serial 대응은 서버가 offset 으로 맞춘다.
    const init = await client.ensure(snap.surface);
    expect(init.spawned).toBe(Math.min(128, snap.spawned));
    expect(init.heightUnits).toBeCloseTo(snap.heightUnits, 3);
    const r = await client.simulate("job-3", 50, 3);
    expect(r.spawned).toBe(init.spawned + 50);
    expect(r.heightUnits).toBeGreaterThan(snap.heightUnits);
    expect(await client.ping()).toBe(true);
  });
});
