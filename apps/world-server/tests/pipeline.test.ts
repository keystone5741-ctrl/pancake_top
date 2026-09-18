import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decodeChunk } from "tower-engine";
import { WorldApp } from "../src/app";
import { loadConfig } from "../src/config";
import type { Db } from "../src/db/db";
import type { WorldEvent } from "../src/world/events";
import { MemoryChunkStorage } from "../src/world/chunkStorage";
import { sha256 } from "../src/world/worldStore";
import { freshDb } from "./helpers";

let db: Db;
let app: WorldApp;
let now = new Date("2026-09-18T03:02:00.000Z");
const storage = new MemoryChunkStorage();
const events: WorldEvent[] = [];
const cfg = loadConfig({ chunkSize: 250, simBatchSize: 100, simBatchWindowMs: 20, queueThrottleMs: 50, snapshotEveryPancakes: 400, workerMaxAttempts: 3 });

async function untilCommitted(timeoutMs = 120_000): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) { await app.store.refresh(); if (app.pendingPancakes === 0) return; app.kick(); await new Promise((r) => setTimeout(r, 100)); }
  throw new Error(`pipeline did not drain: pending ${app.pendingPancakes}`);
}

beforeAll(async () => {
  db = await freshDb();
  app = new WorldApp({ db, storage, config: cfg, clock: () => now });
  app.events.onEvent((e) => events.push(e));
  await app.start();
});
afterAll(async () => { await app.stop(); await db.close(); });

describe("continuous pipeline + persistence", () => {
  it("routes purchases into the current drop, simulates continuously and commits chunks atomically", async () => {
    const results = await Promise.all(Array.from({ length: 40 }, (_, i) => app.purchase({ quantity: 1 + (i % 10), country: ["KR", "JP", "US"][i % 3] })));
    const total = results.reduce((a, r) => a + (r.endSerial - r.startSerial + 1), 0);
    expect(new Set(results.map((r) => r.dropId)).size).toBe(1);
    expect(results[0].dropId).toBe("drop_20260918T031000Z");
    await untilCommitted();
    const ws = app.store.worldState;
    expect(ws.committed_serial).toBe(total);
    expect(ws.latest_global_serial).toBe(total);
    expect(ws.version).toBeGreaterThanOrEqual(Math.ceil(total / 100));
    expect(ws.height_meters).toBeGreaterThan(total * 0.009);
    // manifest: chunk 범위 연속, checksum 일치, 마지막만 mutable
    const m = await app.store.manifest();
    expect(m.version).toBe(ws.version);
    expect(m.totalPancakes).toBe(total);
    let expectStart = 1;
    for (const c of m.chunks) {
      expect(c.startSerial).toBe(expectStart); expectStart = c.endSerial + 1;
      expect(c.storageKey).toMatch(c.finalized ? /\/chunks\/\d{6}-v\d+\.chunk$/ : /\/staging\/\d{6}-v\d+\.chunk$/);
      const bytes = await storage.get(c.storageKey!);
      expect(bytes).not.toBeNull();
      expect(sha256(bytes!)).toBe(c.checksum);
      const dec = decodeChunk(bytes!.buffer.slice(bytes!.byteOffset, bytes!.byteOffset + bytes!.byteLength) as ArrayBuffer).chunk;
      expect(dec.count).toBe(c.count);
      expect(dec.startSerial).toBe(c.startSerial - 1);
      expect(c.finalized).toBe(c.count === cfg.chunkSize);
    }
    expect(m.chunks.filter((c) => !c.finalized).length).toBeLessThanOrEqual(1);
    expect(expectStart - 1).toBe(total);
    // pancake lookup: chunk/instance 와 chunk 안의 높이
    const p = await app.pancake(total);
    expect(p).toMatchObject({ globalSerial: total, chunkId: Math.floor((total - 1) / 250), instanceIndex: (total - 1) % 250, committed: true });
    expect(p!.height as number).toBeGreaterThan(0);
    // 국가 attribute 가 chunk 에 들어갔는지
    const first = decodeChunk(storage.files.get(m.chunks[0].storageKey!)!.data.buffer as ArrayBuffer).chunk;
    const kr = (await db.query<{ instance_index: number }>("SELECT instance_index FROM pancakes WHERE country = 'KR' AND chunk_id = 0 LIMIT 1")).rows[0];
    expect(first.attributes.country[kr.instance_index]).toBe(10 * 26 + 17); // "KR"
    // 이벤트: queueUpdated(throttle) 와 world.updated
    expect(events.filter((e) => e.type === "drop.queueUpdated").length).toBeGreaterThanOrEqual(1);
    expect(events.filter((e) => e.type === "drop.queueUpdated").length).toBeLessThan(40);
    const upd = events.filter((e) => e.type === "world.updated");
    expect(upd.length).toBe(ws.version);
    // 모든 job DONE, 중복 없음
    const jobs = (await db.query<{ status: string; n: number }>("SELECT status, COUNT(*)::int AS n FROM simulation_jobs GROUP BY status")).rows;
    expect(jobs).toEqual([{ status: "DONE", n: ws.version }]);
  });

  it("closes at cutoff, sends late purchases to the next drop, becomes READY then RELEASED at the scheduled time", async () => {
    now = new Date("2026-09-18T03:09:00.500Z"); // cutoff 03:09:00 지남
    await app.tick(now);
    const d = await app.getDrop("drop_20260918T031000Z");
    expect(["CLOSING", "FINALIZING", "READY"]).toContain(d!.status);
    expect(events.some((e) => e.type === "drop.closing" && e.nextDropId === "drop_20260918T032000Z")).toBe(true);
    const late = await app.purchase({ quantity: 3, country: "BR" });
    expect(late.dropId).toBe("drop_20260918T032000Z");
    await untilCommitted();
    await app.tick(now);
    expect((await app.getDrop("drop_20260918T031000Z"))!.status).toBe("READY");
    expect(events.some((e) => e.type === "drop.ready")).toBe(true);
    const snaps = (await db.query<{ n: number }>("SELECT COUNT(*)::int AS n FROM world_snapshots")).rows[0].n;
    expect(snaps).toBeGreaterThanOrEqual(1);
    now = new Date("2026-09-18T03:10:00.000Z");
    await app.tick(now);
    const rel = await app.getDrop("drop_20260918T031000Z");
    expect(rel!.status).toBe("RELEASED");
    const ev = events.find((e) => e.type === "drop.released");
    expect(ev).toMatchObject({ dropId: "drop_20260918T031000Z", startSerial: 1 });
    // 다음 drop 은 OPEN 이고 late purchase 가 들어가 있다
    const nd = await app.getDrop("drop_20260918T032000Z");
    expect(nd!.status === "OPEN" || nd!.status === "SIMULATING").toBe(true);
    expect(nd!.pancake_count).toBe(3);
  });

  it("recovers from a worker crash mid-pipeline without losing or duplicating pancakes", async () => {
    const before = app.store.worldState.committed_serial;
    const crashes = app.metrics.workerCrashes;
    const r = await app.purchase({ quantity: 350, country: "KR" });
    app.worker.devCrash();
    await untilCommitted();
    expect(app.metrics.workerCrashes).toBeGreaterThanOrEqual(crashes + 1);
    expect(app.metrics.jobRetries).toBeGreaterThanOrEqual(1);
    expect(app.store.worldState.committed_serial).toBe(r.endSerial);
    const dup = (await db.query<{ n: number; d: number }>("SELECT COUNT(*)::int AS n, COUNT(DISTINCT global_serial)::int AS d FROM pancakes")).rows[0];
    expect(dup.n).toBe(dup.d);
    expect(dup.n).toBe(r.endSerial);
    const failed = (await db.query<{ n: number }>("SELECT COUNT(*)::int AS n FROM simulation_jobs WHERE status IN ('RUNNING','RETRYABLE','FAILED')")).rows[0].n;
    expect(failed).toBe(0);
    expect(app.store.worldState.committed_serial).toBeGreaterThan(before);
  });

  it("keeps the previous version authoritative when the chunk write fails (atomic commit)", async () => {
    const v0 = app.store.version;
    storage.failNextPut = true;
    const r = await app.purchase({ quantity: 20, country: "JP" });
    await untilCommitted();
    expect(app.store.version).toBeGreaterThan(v0);
    expect(app.store.worldState.committed_serial).toBe(r.endSerial);
    expect(app.metrics.jobRetries).toBeGreaterThanOrEqual(2);
    const m = await app.store.manifest();
    for (const c of m.chunks) expect(sha256((await storage.get(c.storageKey!))!)).toBe(c.checksum);
    // 참조되지 않는 staging 객체가 남지 않는다
    const keys = await storage.list("worlds/");
    expect(keys.sort()).toEqual(m.chunks.map((c) => c.storageKey!).sort());
  });
});
