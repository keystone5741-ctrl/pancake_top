import { randomUUID } from "node:crypto";
import type { Db, Queryable } from "../db/db";

export interface AllocationRequest {
  quantity: number;
  country: string;
  dropId: string;
  idempotencyKey?: string | null;
  orderId?: string;
  chunkSize: number;
}
export interface Allocation {
  orderId: string;
  dropId: string;
  startSerial: number;
  endSerial: number;
  countryStartSerial: number;
  countryEndSerial: number;
  /** 같은 idempotencyKey 로 이미 처리된 주문을 돌려준 경우 */
  replayed: boolean;
}

/**
 * Global / Country Serial 원자적 할당 (Phase 2 §8~§10).
 * world_state 행을 FOR UPDATE 로 잠근 트랜잭션 안에서 global 카운터와 국가 카운터를 함께 올리고
 * order + pancakes 행을 만든다. idempotencyKey 가 같으면 기존 주문을 그대로 돌려준다.
 */
export async function allocateSerials(db: Db, worldId: string, req: AllocationRequest): Promise<Allocation> {
  if (!Number.isInteger(req.quantity) || req.quantity <= 0 || req.quantity > 10_000) throw new Error("quantity must be 1..10000");
  const country = normalizeCountry(req.country);
  return db.tx(async (c) => {
    if (req.idempotencyKey) {
      const existing = await c.query<{ order_id: string; drop_id: string; start_serial: number; end_serial: number; country: string }>("SELECT order_id, drop_id, start_serial, end_serial, country FROM orders WHERE idempotency_key = $1", [req.idempotencyKey]);
      if (existing.rows.length) {
        const o = existing.rows[0];
        const cs = await c.query<{ min: number; max: number }>("SELECT MIN(country_serial) AS min, MAX(country_serial) AS max FROM pancakes WHERE order_id = $1", [o.order_id]);
        return { orderId: o.order_id, dropId: o.drop_id, startSerial: o.start_serial, endSerial: o.end_serial, countryStartSerial: cs.rows[0].min, countryEndSerial: cs.rows[0].max, replayed: true };
      }
    }
    const ws = await c.query<{ latest_global_serial: number }>("SELECT latest_global_serial FROM world_state WHERE world_id = $1 FOR UPDATE", [worldId]);
    if (!ws.rows.length) throw new Error(`world ${worldId} not initialised`);
    const start = ws.rows[0].latest_global_serial + 1;
    const end = start + req.quantity - 1;
    await c.query("UPDATE world_state SET latest_global_serial = $2, updated_at = now() WHERE world_id = $1", [worldId, end]);
    const cc = await c.query<{ latest_serial: number }>(
      "INSERT INTO country_counters (country, latest_serial) VALUES ($1, $2) ON CONFLICT (country) DO UPDATE SET latest_serial = country_counters.latest_serial + EXCLUDED.latest_serial RETURNING latest_serial",
      [country, req.quantity],
    );
    const cEnd = cc.rows[0].latest_serial;
    const cStart = cEnd - req.quantity + 1;
    const orderId = req.orderId ?? `order_${randomUUID()}`;
    await c.query(
      "INSERT INTO orders (order_id, idempotency_key, quantity, country, drop_id, start_serial, end_serial, status) VALUES ($1, $2, $3, $4, $5, $6, $7, 'ALLOCATED')",
      [orderId, req.idempotencyKey ?? null, req.quantity, country, req.dropId, start, end],
    );
    // pancakes: chunk = floor((serial-1)/chunkSize), instance = (serial-1) mod chunkSize
    await c.query(
      `INSERT INTO pancakes (pancake_id, global_serial, country, country_serial, drop_id, order_id, chunk_id, instance_index, variant)
       SELECT s, s, $1, $2 + (s - $3), $4, $5, ((s - 1) / $6)::int, ((s - 1) % $6)::int, 0 FROM generate_series($3::bigint, $7::bigint) AS s`,
      [country, cStart, start, req.dropId, orderId, req.chunkSize, end],
    );
    await c.query(
      "UPDATE drops SET start_serial = LEAST(COALESCE(start_serial, $2), $2), end_serial = GREATEST(COALESCE(end_serial, $3), $3), pancake_count = pancake_count + $4 WHERE drop_id = $1",
      [req.dropId, start, end, req.quantity],
    );
    return { orderId, dropId: req.dropId, startSerial: start, endSerial: end, countryStartSerial: cStart, countryEndSerial: cEnd, replayed: false };
  });
}

export function normalizeCountry(code: string | undefined | null): string {
  const c = (code ?? "ZZ").toUpperCase().trim();
  return /^[A-Z]{2}$/.test(c) ? c : "ZZ";
}

export async function ensureWorld(q: Queryable, worldId: string): Promise<void> {
  await q.query("INSERT INTO world_state (world_id) VALUES ($1) ON CONFLICT (world_id) DO NOTHING", [worldId]);
}
