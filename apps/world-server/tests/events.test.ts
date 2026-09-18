import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WorldApp } from "../src/app";
import { loadConfig } from "../src/config";
import type { Db } from "../src/db/db";
import { MemoryChunkStorage } from "../src/world/chunkStorage";
import type { WorldEvent } from "../src/world/events";
import { freshDb } from "./helpers";

let db: Db;
let app: WorldApp;
let now = new Date("2026-09-18T07:02:00.000Z");
const cfg = loadConfig({ chunkSize: 200, simBatchSize: 50, simBatchWindowMs: 0, queueThrottleMs: 20, snapshotEveryPancakes: 1e9, eventRetentionHours: 24, eventRetentionCount: 1e9, instanceId: "ev-a" });
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function drain(): Promise<void> { const t0 = Date.now(); while (Date.now() - t0 < 120_000) { await app.store.refresh(); if (app.pendingPancakes === 0) break; app.kick(); await wait(50); } await wait(200); }

beforeAll(async () => { db = await freshDb(); app = new WorldApp({ db, storage: new MemoryChunkStorage(), config: cfg, clock: () => now, cluster: false }); await app.start(); });
afterAll(async () => { await app.stop(); await db.close(); });

describe("durable world event log (Phase 3A §17~§20)", () => {
  it("records the drop / simulation / chunk / world events in order with ids, and delivers them locally", async () => {
    const seen: WorldEvent[] = [];
    const off = app.events.onEvent((e) => seen.push(e));
    await app.purchase({ quantity: 120, country: "KR" });
    await drain();
    now = new Date("2026-09-18T07:09:00.000Z"); await app.tick(); // CLOSING → READY
    now = new Date("2026-09-18T07:10:00.000Z"); await app.tick(); // RELEASED
    await wait(100);
    off();
    const rows = (await db.query<{ event_id: number; type: string; drop_id: string | null; world_version: number; retain: boolean }>("SELECT event_id, type, drop_id, world_version, retain FROM world_events ORDER BY event_id")).rows;
    const types = rows.map((r) => r.type);
    for (const t of ["drop.opened", "simulation.started", "simulation.completed", "chunk.committed", "world.updated", "drop.queueUpdated", "drop.closing", "drop.ready", "drop.released"]) expect(types).toContain(t);
    // 순서: started < completed < world.updated (첫 job), closing < ready < released
    const idx = (t: string): number => types.indexOf(t);
    expect(idx("simulation.started")).toBeLessThan(idx("simulation.completed"));
    expect(idx("simulation.completed")).toBeLessThan(idx("world.updated"));
    expect(idx("drop.closing")).toBeLessThan(idx("drop.ready"));
    expect(idx("drop.ready")).toBeLessThan(idx("drop.released"));
    // event_id 단조 증가, drop 이벤트는 drop_id, world_version 기록
    for (let i = 1; i < rows.length; i++) expect(rows[i].event_id).toBeGreaterThan(rows[i - 1].event_id);
    expect(rows.find((r) => r.type === "drop.released")!.drop_id).toBe("drop_20260918T071000Z");
    expect(rows.find((r) => r.type === "drop.released")!.retain).toBe(true); // 감사 이벤트
    expect(rows.find((r) => r.type === "world.updated")!.retain).toBe(false);
    // 로컬 구독자도 eventId 를 받는다
    expect(seen.filter((e) => e.type === "world.updated").every((e) => typeof e.eventId === "number")).toBe(true);
  });
  it("replays events after lastEventId, and falls back to snapshot when the id is older than the retention boundary", async () => {
    const all = await app.eventLog.after(0, 10_000);
    const mid = all[Math.floor(all.length / 2)].eventId;
    const replay = await app.eventLog.replay(mid);
    expect(replay).not.toBeNull();
    expect(replay!.map((e) => e.eventId)).toEqual(all.filter((e) => e.eventId > mid).map((e) => e.eventId));
    expect(await app.eventLog.replay(all[all.length - 1].eventId)).toEqual([]);
    // retention: 개수 제한으로 prune → 오래된 lastEventId 는 replay 불가 (snapshot), 감사 이벤트는 남는다
    app.eventLog.opts.retentionCount = 3;
    const pruned = await app.eventLog.prune();
    expect(pruned).toBeGreaterThan(0);
    expect(await app.eventLog.replay(0)).toBeNull();
    const kept = (await db.query<{ type: string; retain: boolean }>("SELECT type, retain FROM world_events ORDER BY event_id")).rows;
    expect(kept.some((r) => r.type === "drop.released" && r.retain)).toBe(true);
    expect(kept.filter((r) => !r.retain).length).toBeLessThanOrEqual(3);
    const boundary = await app.eventLog.prunedUpTo();
    expect(await app.eventLog.replay(boundary)).not.toBeNull();
    app.eventLog.opts.retentionCount = 1e9;
  });
  it("delivers events appended by another instance through LISTEN/NOTIFY, in id order, without echoing its own", async () => {
    const other = new WorldApp({ db, storage: new MemoryChunkStorage(), config: { ...cfg, instanceId: "ev-b" }, clock: () => now, cluster: false });
    // 두 번째 인스턴스는 leader 가 아니어야 하지만 cluster:false 는 단독 leader 로 취급하므로 LISTEN 만 쓴다
    await other.eventLog.startListening();
    const got: WorldEvent[] = [];
    other.eventLog.onEvent((e) => got.push({ ...(e.payload as object), eventId: e.eventId } as WorldEvent));
    const mine: number[] = [];
    app.events.onEvent((e) => { if (e.type === "drop.queueUpdated") mine.push(e.eventId!); });
    await app.publish({ type: "drop.queueUpdated", dropId: "drop_x", queueSize: 1, scheduledAt: now.toISOString() });
    await app.publish({ type: "drop.queueUpdated", dropId: "drop_x", queueSize: 2, scheduledAt: now.toISOString() });
    await other.publish({ type: "drop.queueUpdated", dropId: "drop_y", queueSize: 3, scheduledAt: now.toISOString() });
    const t0 = Date.now(); while (got.length < 2 && Date.now() - t0 < 5000) await wait(20);
    const fromA = got.filter((e) => e.type === "drop.queueUpdated" && (e as { dropId: string }).dropId === "drop_x");
    expect(fromA.map((e) => (e as { queueSize: number }).queueSize)).toEqual([1, 2]);
    expect(got.filter((e) => (e as { dropId?: string }).dropId === "drop_y").length).toBe(0); // 자기 것은 LISTEN 으로 다시 받지 않는다 (append 때 이미 배달)
    expect(other.eventLog.metrics.lagMsLast).toBeLessThan(2000);
    await other.eventLog.stopListening();
  });
});
