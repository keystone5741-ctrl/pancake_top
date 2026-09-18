import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WorldApp } from "../src/app";
import { loadConfig } from "../src/config";
import type { Db } from "../src/db/db";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalChunkStorage } from "../src/world/chunkStorage";
import { freshDb } from "./helpers";

let db: Db;
let app: WorldApp;
const now = new Date("2026-09-18T03:02:00.000Z");
const cfg = loadConfig({ chunkSize: 500, simBatchSize: 20, simBatchWindowMs: 0, queueThrottleMs: 50, snapshotEveryPancakes: 1e9 });

beforeAll(async () => { db = await freshDb(); app = new WorldApp({ db, storage: new LocalChunkStorage(mkdtempSync(join(tmpdir(), "pancake-conc-"))), config: cfg, clock: () => now }); await app.start(); });
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
    // refresh() 를 커밋과 경쟁시킨다 (regression: stale world_state 로 덮어써 "commit out of order")
    const t0 = Date.now();
    let refreshes = 0;
    while (Date.now() - t0 < 120_000) { await app.store.refresh(); refreshes++; if (app.pendingPancakes === 0) break; app.kick(); }
    expect(refreshes).toBeGreaterThan(10);
    expect(app.pendingPancakes).toBe(0);
    expect(app.store.committedSerial).toBe(allocated);
    expect(app.metrics.jobRetries).toBe(0);
    const rows = (await db.query<{ n: number }>("SELECT COUNT(*)::int AS n FROM pancakes WHERE committed_at IS NULL")).rows[0].n;
    expect(rows).toBe(0);
  });
});

describe("WorldStore refresh vs commit", () => {
  it("a refresh whose read is delayed past a commit does not overwrite the fresh state (regression: 'commit out of order')", async () => {
    const { WorldStore } = await import("../src/world/worldStore");
    const { MemoryChunkStorage } = await import("../src/world/chunkStorage");
    const { emptyTransformSet } = await import("pancake-core");
    const db2 = await freshDb();
    // refresh 의 world_state SELECT 결과를 gate 뒤로 미룬다 — pool 포화로 응답이 커밋 뒤에 도착하는 상황
    let gate: Promise<void> = Promise.resolve(); let open!: () => void;
    const gated = new Proxy(db2, { get(t, k) { if (k !== "query") return Reflect.get(t, k); return async (sql: string, params?: unknown[]) => { const r = await t.query(sql, params); if (sql.startsWith("SELECT * FROM world_state")) await gate; return r; }; } });
    const store = new WorldStore(gated as typeof db2, new MemoryChunkStorage(), loadConfig({ chunkSize: 100 }));
    await store.load();
    const set = emptyTransformSet(5, 1, 0.1, 10, 0);
    for (let i = 0; i < 5; i++) { set.py[i] = 0.05 + i * 0.1; set.qw[i] = 1; set.scale[i] = 1; set.tscale[i] = 1; }
    gate = new Promise((r) => { open = r; });
    const refreshing = store.refresh(); // 읽기는 끝났지만 결과 반영이 gate 에 걸려 있다
    const committing = store.commit({ jobId: "j1", dropId: "d", startSerial: 1, endSerial: 5, finalTransforms: { ...set }, heightUnits: 0.5, countries: new Uint16Array(5) });
    await Promise.race([committing, new Promise((r) => setTimeout(r, 500))]); // 직렬화돼 있으면 commit 은 refresh 를 기다린다
    open();
    await Promise.all([refreshing, committing]);
    expect(store.committedSerial).toBe(5);
    // 다음 커밋이 어긋나지 않는다
    await store.commit({ jobId: "j2", dropId: "d", startSerial: 6, endSerial: 10, finalTransforms: { ...set }, heightUnits: 1, countries: new Uint16Array(5) });
    expect(store.committedSerial).toBe(10);
    expect((await store.manifest()).chunks[0].count).toBe(10);
    await db2.close();
  });
});
