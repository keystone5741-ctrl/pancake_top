import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../src/db/db";
import { allocateSerials } from "../src/world/serial";
import { freshDb } from "./helpers";

let db: Db;
beforeAll(async () => { db = await freshDb(); await db.query("INSERT INTO drops (drop_id, scheduled_at, cutoff_at, status) VALUES ('drop_A', now(), now(), 'OPEN')"); });
afterAll(async () => { await db.close(); });

describe("serial allocation", () => {
  it("allocates contiguous unique global and country serials under concurrency", async () => {
    const reqs = Array.from({ length: 60 }, (_, i) => allocateSerials(db, "world", { quantity: 1 + (i % 10), country: i % 3 === 0 ? "KR" : i % 3 === 1 ? "JP" : "US", dropId: "drop_A", chunkSize: 100 }));
    const results = await Promise.all(reqs);
    const ranges = results.map((r) => [r.startSerial, r.endSerial]).sort((a, b) => a[0] - b[0]);
    let expectedStart = 1;
    for (const [s, e] of ranges) { expect(s).toBe(expectedStart); expect(e).toBeGreaterThanOrEqual(s); expectedStart = e + 1; }
    const total = results.reduce((a, r) => a + (r.endSerial - r.startSerial + 1), 0);
    const rows = await db.query<{ n: number; d: number }>("SELECT COUNT(*)::int AS n, COUNT(DISTINCT global_serial)::int AS d FROM pancakes");
    expect(rows.rows[0]).toEqual({ n: total, d: total });
    // 국가별 serial 도 1..N 연속·유일
    for (const country of ["KR", "JP", "US"]) {
      const cs = await db.query<{ n: number; mn: number; mx: number; d: number }>("SELECT COUNT(*)::int AS n, MIN(country_serial)::int AS mn, MAX(country_serial)::int AS mx, COUNT(DISTINCT country_serial)::int AS d FROM pancakes WHERE country = $1", [country]);
      expect(cs.rows[0].mn).toBe(1); expect(cs.rows[0].mx).toBe(cs.rows[0].n); expect(cs.rows[0].d).toBe(cs.rows[0].n);
    }
    // chunk / instance 유도
    const p = await db.query<{ chunk_id: number; instance_index: number }>("SELECT chunk_id, instance_index FROM pancakes WHERE global_serial = 250");
    expect(p.rows[0]).toEqual({ chunk_id: 2, instance_index: 49 });
    const ws = await db.query<{ latest_global_serial: number }>("SELECT latest_global_serial FROM world_state");
    expect(ws.rows[0].latest_global_serial).toBe(total);
    const d = await db.query<{ pancake_count: number; start_serial: number; end_serial: number }>("SELECT pancake_count, start_serial, end_serial FROM drops WHERE drop_id = 'drop_A'");
    expect(d.rows[0]).toEqual({ pancake_count: total, start_serial: 1, end_serial: total });
  });

  it("is idempotent for the same idempotencyKey", async () => {
    const a = await allocateSerials(db, "world", { quantity: 5, country: "KR", dropId: "drop_A", chunkSize: 100, idempotencyKey: "key-1" });
    const b = await allocateSerials(db, "world", { quantity: 5, country: "KR", dropId: "drop_A", chunkSize: 100, idempotencyKey: "key-1" });
    expect(b.replayed).toBe(true);
    expect(b.orderId).toBe(a.orderId);
    expect([b.startSerial, b.endSerial]).toEqual([a.startSerial, a.endSerial]);
    expect([b.countryStartSerial, b.countryEndSerial]).toEqual([a.countryStartSerial, a.countryEndSerial]);
    const n = await db.query<{ n: number }>("SELECT COUNT(*)::int AS n FROM pancakes WHERE order_id = $1", [a.orderId]);
    expect(n.rows[0].n).toBe(5);
    // 동시 재시도도 하나만 만든다
    const many = await Promise.allSettled(Array.from({ length: 5 }, () => allocateSerials(db, "world", { quantity: 3, country: "JP", dropId: "drop_A", chunkSize: 100, idempotencyKey: "key-2" })));
    const ok = many.filter((m) => m.status === "fulfilled").map((m) => (m as PromiseFulfilledResult<Awaited<ReturnType<typeof allocateSerials>>>).value);
    expect(ok.length).toBeGreaterThanOrEqual(1);
    const orders = await db.query<{ n: number }>("SELECT COUNT(*)::int AS n FROM orders WHERE idempotency_key = 'key-2'");
    expect(orders.rows[0].n).toBe(1);
    const starts = new Set(ok.map((o) => o.startSerial));
    expect(starts.size).toBe(1);
  });

  it("rejects invalid quantity and normalises country", async () => {
    await expect(allocateSerials(db, "world", { quantity: 0, country: "KR", dropId: "drop_A", chunkSize: 100 })).rejects.toThrow();
    const r = await allocateSerials(db, "world", { quantity: 1, country: "kr", dropId: "drop_A", chunkSize: 100 });
    const p = await db.query<{ country: string }>("SELECT country FROM pancakes WHERE global_serial = $1", [r.startSerial]);
    expect(p.rows[0].country).toBe("KR");
    const z = await allocateSerials(db, "world", { quantity: 1, country: "??", dropId: "drop_A", chunkSize: 100 });
    const pz = await db.query<{ country: string }>("SELECT country FROM pancakes WHERE global_serial = $1", [z.startSerial]);
    expect(pz.rows[0].country).toBe("ZZ");
  });
});
