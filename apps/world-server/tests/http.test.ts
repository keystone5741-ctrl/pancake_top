import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import WebSocket from "ws";
import { WorldApp } from "../src/app";
import { loadConfig } from "../src/config";
import type { Db } from "../src/db/db";
import { createHttpServer } from "../src/http/server";
import { MemoryChunkStorage } from "../src/world/chunkStorage";
import { freshDb } from "./helpers";

let db: Db; let app: WorldApp; let base = ""; let server: ReturnType<typeof createHttpServer>["server"];
const now = new Date("2026-09-18T07:01:00.000Z");
const cfg = loadConfig({ chunkSize: 100, simBatchSize: 50, simBatchWindowMs: 10, queueThrottleMs: 20 });

async function drain(): Promise<void> { const t0 = Date.now(); while (Date.now() - t0 < 60_000) { await app.store.refresh(); if (app.pendingPancakes === 0) return; app.kick(); await new Promise((r) => setTimeout(r, 100)); } throw new Error("no drain"); }
function wsEvents(url: string, count: number, timeoutMs = 10_000): Promise<{ ws: WebSocket; events: Record<string, unknown>[] }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url); const events: Record<string, unknown>[] = [];
    const timer = setTimeout(() => reject(new Error("ws timeout")), timeoutMs);
    ws.on("message", (d) => { events.push(JSON.parse(String(d))); if (events.length >= count) { clearTimeout(timer); resolve({ ws, events }); } });
    ws.on("error", reject);
  });
}

beforeAll(async () => {
  db = await freshDb();
  app = new WorldApp({ db, storage: new MemoryChunkStorage(), config: cfg, clock: () => now });
  await app.start();
  server = createHttpServer(app).server;
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { server.close(); await app.stop(); await db.close(); });

describe("HTTP API", () => {
  it("purchase (idempotent) → world → manifest → chunk (etag, immutable) → pancake lookup", async () => {
    const r1 = await fetch(`${base}/api/dev/purchase`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "http-1" }, body: JSON.stringify({ quantity: 120, country: "kr" }) });
    expect(r1.status).toBe(201);
    const p1 = await r1.json() as { orderId: string; startSerial: number; endSerial: number; dropId: string };
    expect(p1).toMatchObject({ startSerial: 1, endSerial: 120, dropId: "drop_20260918T071000Z" });
    const r2 = await fetch(`${base}/api/dev/purchase`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ quantity: 120, country: "kr", idempotencyKey: "http-1" }) });
    expect(r2.status).toBe(200);
    expect((await r2.json() as { orderId: string }).orderId).toBe(p1.orderId);
    expect((await (await fetch(`${base}/api/dev/purchase`, { method: "POST", body: JSON.stringify({ quantity: 0 }) })).json() as { error: string }).error).toMatch(/quantity/);
    await drain();
    const world = await (await fetch(`${base}/api/world`)).json() as { type: string; committedPancakes: number; currentDrop: { dropId: string } };
    expect(world.type).toBe("world.snapshot"); expect(world.committedPancakes).toBe(120); expect(world.currentDrop.dropId).toBe("drop_20260918T071000Z");
    const mr = await fetch(`${base}/api/world/manifest`);
    const m = await mr.json() as { version: number; chunks: { id: number; url: string; checksum: string; finalized: boolean }[] };
    expect(mr.headers.get("etag")).toBe(`"v${m.version}"`);
    expect(m.chunks.length).toBe(2);
    const c0 = await fetch(`${base}${m.chunks[0].url}`);
    expect(c0.status).toBe(200);
    expect(c0.headers.get("cache-control")).toContain("immutable");
    expect(c0.headers.get("x-chunk-sha256")).toBe(m.chunks[0].checksum);
    const c1 = await fetch(`${base}${m.chunks[1].url}`);
    expect(c1.headers.get("cache-control")).toBe("no-cache");
    const again = await fetch(`${base}${m.chunks[0].url}`, { headers: { "if-none-match": c0.headers.get("etag")! } });
    expect(again.status).toBe(304);
    expect((await fetch(`${base}/api/world/chunks/99`)).status).toBe(404);
    const pk = await (await fetch(`${base}/api/pancakes/101`)).json() as { chunkId: number; instanceIndex: number; countrySerial: number; country: string; height: number };
    expect(pk).toMatchObject({ chunkId: 1, instanceIndex: 0, country: "KR", countrySerial: 101 });
    expect(pk.height).toBeGreaterThan(0.9);
    expect((await fetch(`${base}/api/pancakes/999999`)).status).toBe(404);
    const cur = await (await fetch(`${base}/api/drops/current`)).json() as { drop_id: string; pancake_count: number };
    expect(cur).toMatchObject({ drop_id: "drop_20260918T071000Z", pancake_count: 120 });
    expect((await (await fetch(`${base}/api/dev/status`)).json() as { pending: number }).pending).toBe(0);
  });

  it("WebSocket: snapshot on connect, events on purchase/commit, snapshot again after reconnect", async () => {
    const wsUrl = base.replace("http", "ws") + "/ws";
    const { ws, events } = await wsEvents(wsUrl, 1);
    expect(events[0]).toMatchObject({ type: "world.snapshot", committedPancakes: 120 });
    const more = new Promise<Record<string, unknown>[]>((resolve) => { const got: Record<string, unknown>[] = []; ws.on("message", (d) => { got.push(JSON.parse(String(d))); if (got.some((e) => e.type === "world.updated") && got.some((e) => e.type === "drop.queueUpdated")) resolve(got); }); });
    await fetch(`${base}/api/dev/purchase`, { method: "POST", body: JSON.stringify({ quantity: 30, country: "JP" }) });
    const got = await more;
    expect(got.some((e) => e.type === "drop.queueUpdated" && (e as { queueSize: number }).queueSize === 150)).toBe(true);
    ws.close();
    await drain();
    const re = await wsEvents(wsUrl, 1);
    expect(re.events[0]).toMatchObject({ type: "world.snapshot", committedPancakes: 150, version: app.store.version });
    re.ws.send(JSON.stringify({ type: "resync" }));
    const resync = await new Promise<Record<string, unknown>>((resolve) => re.ws.once("message", (d) => resolve(JSON.parse(String(d)))));
    expect(resync.type).toBe("world.snapshot");
    re.ws.close();
  });
});
