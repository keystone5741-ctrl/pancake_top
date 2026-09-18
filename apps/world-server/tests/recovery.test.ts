import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WorldApp } from "../src/app";
import { loadConfig } from "../src/config";
import type { Db } from "../src/db/db";
import { MemoryChunkStorage } from "../src/world/chunkStorage";
import { sha256 } from "../src/world/worldStore";
import { freshDb } from "./helpers";

let db: Db;
const storage = new MemoryChunkStorage();
const cfg = loadConfig({ chunkSize: 100, simBatchSize: 60, simBatchWindowMs: 10, queueThrottleMs: 20 });
let now = new Date("2026-09-18T05:01:00.000Z");

async function drain(app: WorldApp): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < 120_000) { await app.store.refresh(); if (app.pendingPancakes === 0) return; app.kick(); await new Promise((r) => setTimeout(r, 100)); }
  throw new Error("pipeline did not drain");
}

beforeAll(async () => { db = await freshDb(); });
afterAll(async () => { await db.close(); });

describe("restart recovery", () => {
  it("rebuilds chunk files from the database, resumes uncommitted pancakes and keeps serials continuous", async () => {
    const app1 = new WorldApp({ db, storage, config: cfg, clock: () => now });
    await app1.start();
    const a = await app1.purchase({ quantity: 230, country: "KR" });
    await drain(app1);
    const v1 = app1.store.version;
    const m1 = await app1.store.manifest();
    // "crash": 파이프라인이 돌기 전에 구매만 들어온 상태를 만든다
    await app1.stop();
    const b = await app1.purchase({ quantity: 45, country: "JP" }).catch(() => null); // stopped 상태라 파이프라인은 돌지 않지만 할당은 된다
    expect(b).not.toBeNull();
    // 파일 손상 + DB 에 없는 잔여 파일 (chunk 저장 후 DB 커밋 전 crash 상황)
    const key0 = m1.chunks[0].storageKey!;
    await storage.put(key0, new Uint8Array([1, 2, 3]));
    await storage.put("worlds/world/staging/000099-v9.chunk", new Uint8Array([9]));
    await db.query("UPDATE simulation_jobs SET status = 'RUNNING' WHERE job_id = (SELECT job_id FROM simulation_jobs ORDER BY created_at DESC LIMIT 1)");

    const app2 = new WorldApp({ db, storage, config: cfg, clock: () => now });
    await app2.start();
    expect(app2.store.metrics.recoveredFiles).toBeGreaterThanOrEqual(2);
    expect(await storage.get("worlds/world/staging/000099-v9.chunk")).toBeNull();
    expect(sha256((await storage.get(key0))!)).toBe(m1.chunks[0].checksum);
    expect(app2.store.version).toBe(v1);
    const retryable = (await db.query<{ n: number }>("SELECT COUNT(*)::int AS n FROM simulation_jobs WHERE status = 'RETRYABLE'")).rows[0].n;
    expect(retryable).toBeGreaterThanOrEqual(1);
    // 미커밋 45장이 이어서 시뮬레이션되고 mutable chunk 에 이어 붙는다
    await drain(app2);
    expect(app2.store.worldState.committed_serial).toBe(a.endSerial + 45);
    const m2 = await app2.store.manifest();
    expect(m2.version).toBeGreaterThan(v1);
    expect(m2.chunks.length).toBe(Math.ceil((a.endSerial + 45) / 100));
    expect(m2.chunks[2].count).toBe(75);
    // 완료된 chunk 는 그대로 (immutable)
    expect(m2.chunks[0].checksum).toBe(m1.chunks[0].checksum);
    expect(m2.chunks[1].checksum).toBe(m1.chunks[1].checksum);
    const c = await app2.purchase({ quantity: 1, country: "US" });
    expect(c.startSerial).toBe(a.endSerial + 46);
    await drain(app2);
    const ws = (await db.query<{ n: number; d: number }>("SELECT COUNT(*)::int AS n, COUNT(DISTINCT global_serial)::int AS d FROM pancakes")).rows[0];
    expect(ws).toEqual({ n: c.endSerial, d: c.endSerial });
    await app2.stop();
  });

  it("stops retrying after the configured attempts and marks the drop FAILED", async () => {
    const cfgFail = loadConfig({ ...cfg, workerMaxAttempts: 1 });
    const app = new WorldApp({ db, storage, config: cfgFail, clock: () => now });
    await app.start();
    // 다음 job 이 반드시 실패하도록: worker 를 계속 죽인다
    const origSimulate = app.worker.simulate.bind(app.worker);
    app.worker.simulate = async () => { app.worker.devCrash(); return origSimulate("x", 1, 1); };
    await app.purchase({ quantity: 5, country: "KR" });
    const t0 = Date.now();
    while (Date.now() - t0 < 60_000) { const f = (await db.query<{ n: number }>("SELECT COUNT(*)::int AS n FROM simulation_jobs WHERE status = 'FAILED'")).rows[0].n; if (f > 0) break; app.kick(); await new Promise((r) => setTimeout(r, 100)); }
    const failed = (await db.query<{ n: number }>("SELECT COUNT(*)::int AS n FROM simulation_jobs WHERE status = 'FAILED'")).rows[0].n;
    expect(failed).toBe(1);
    const d = await app.currentDrop();
    expect(["FAILED"]).toContain((await app.getDrop(d.drop_id))!.status === "FAILED" ? "FAILED" : (await db.query<{ status: string }>("SELECT status FROM drops WHERE status = 'FAILED'")).rows[0]?.status);
    await app.stop();
    // 실패 job 을 정리하면 다시 진행 가능해야 한다 (운영자 개입 시뮬레이션)
    await db.query("UPDATE simulation_jobs SET status = 'RETRYABLE', attempt = 0 WHERE status = 'FAILED'");
    await db.query("UPDATE drops SET status = 'OPEN' WHERE status = 'FAILED'");
  });
});
