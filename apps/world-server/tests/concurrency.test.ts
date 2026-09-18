import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WorldApp } from "../src/app";
import { loadConfig } from "../src/config";
import type { Db } from "../src/db/db";
import { MemoryChunkStorage } from "../src/world/chunkStorage";
import { freshDb } from "./helpers";

let db: Db;
let app: WorldApp;
const now = new Date("2026-09-18T03:02:00.000Z");
const cfg = loadConfig({ chunkSize: 500, simBatchSize: 20, simBatchWindowMs: 0, queueThrottleMs: 50, snapshotEveryPancakes: 1e9 });

beforeAll(async () => { db = await freshDb(); app = new WorldApp({ db, storage: new MemoryChunkStorage(), config: cfg, clock: () => now }); await app.start(); });
afterAll(async () => { await app.stop(); await db.close(); });

describe("purchase / commit concurrency", () => {
  it("does not deadlock when purchases race with world commits (regression: world_state vs drops lock order)", async () => {
    // 파이프라인이 20장 job 을 계속 커밋하는 동안 20개씩 동시 구매를 30 웨이브
    const errors: string[] = [];
    let allocated = 0;
    for (let wave = 0; wave < 30; wave++) {
      const reqs = Array.from({ length: 20 }, (_, i) => app.purchase({ quantity: 1 + (i % 5), country: ["KR", "KR", "US", "JP"][i % 4] }).then((r) => { allocated += r.endSerial - r.startSerial + 1; }).catch((e) => { errors.push(String(e)); }));
      await Promise.all(reqs);
    }
    expect(errors).toEqual([]);
    const t0 = Date.now();
    while (Date.now() - t0 < 120_000) { await app.store.refresh(); if (app.pendingPancakes === 0) break; app.kick(); await new Promise((r) => setTimeout(r, 100)); }
    expect(app.pendingPancakes).toBe(0);
    expect(app.store.committedSerial).toBe(allocated);
    expect(app.metrics.jobRetries).toBe(0);
    const rows = (await db.query<{ n: number }>("SELECT COUNT(*)::int AS n FROM pancakes WHERE committed_at IS NULL")).rows[0].n;
    expect(rows).toBe(0);
  });
});
