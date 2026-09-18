import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WorldApp } from "../src/app";
import { loadConfig } from "../src/config";
import { Db } from "../src/db/db";
import { MemoryChunkStorage } from "../src/world/chunkStorage";
import { TEST_DB_URL, freshDb } from "./helpers";

/**
 * Multi-instance (Phase 3A §21~§25): 같은 DB 를 쓰는 두 WorldApp. advisory lock 으로 하나만 leader.
 * leader 가 "죽으면"(커넥션 끊김) 다른 쪽이 잡고 같은 Drop 을 이어간다. job 이중 실행 0, serial 중복 0.
 */
let dbA: Db; let dbB: Db;
const storage = new MemoryChunkStorage();
let now = new Date("2026-09-18T08:02:00.000Z");
const base = loadConfig({ chunkSize: 300, simBatchSize: 40, simBatchWindowMs: 0, queueThrottleMs: 20, snapshotEveryPancakes: 1e9, leaderLeaseMs: 300, jobLeaseMs: 3000 });
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const until = async (fn: () => boolean | Promise<boolean>, ms = 30_000): Promise<void> => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return; await wait(50); } throw new Error("timeout"); };

beforeAll(async () => { dbA = await freshDb(); dbB = new Db(TEST_DB_URL); });
afterAll(async () => { await dbA.close(); await dbB.close(); });

describe("leader election and failover", () => {
  it("only one of two instances becomes leader; the other still ingests purchases; on leader crash the other takes over the same drop with no duplicate jobs", async () => {
    const a = new WorldApp({ db: dbA, storage, config: { ...base, instanceId: "A" }, clock: () => now });
    const b = new WorldApp({ db: dbB, storage, config: { ...base, instanceId: "B" }, clock: () => now });
    await a.start();
    await b.start();
    await until(() => a.leaderNow || b.leaderNow);
    await wait(400);
    expect(a.leaderNow !== b.leaderNow).toBe(true);
    const leader = a.leaderNow ? a : b, follower = a.leaderNow ? b : a;
    const lease = (await dbA.query<{ instance_id: string; term: number }>("SELECT instance_id, term FROM leader_lease")).rows[0];
    expect(lease.instance_id).toBe(leader.instanceId);
    // follower 도 구매를 받는다 (serial 은 DB 원자 할당)
    const r1 = await follower.purchase({ quantity: 70, country: "KR" });
    const r2 = await leader.purchase({ quantity: 90, country: "JP" });
    expect(r2.startSerial).toBe(r1.endSerial + 1);
    expect(r1.dropId).toBe(r2.dropId);
    // leader 가 일부 커밋 → "crash" (advisory lock 커넥션 끊김 + 파이프라인 정지)
    await until(async () => { await leader.store.refresh(); return leader.store.committedSerial >= 40; });
    const committedBefore = leader.store.committedSerial;
    await leader.leader.simulateCrash();
    await leader.stop();
    await until(() => follower.leaderNow, 15_000);
    const lease2 = (await dbA.query<{ instance_id: string; term: number }>("SELECT instance_id, term FROM leader_lease")).rows[0];
    expect(lease2.instance_id).toBe(follower.instanceId);
    expect(lease2.term).toBe(lease.term + 1);
    // 같은 Drop 이 이어진다: 남은 팬케이크가 새 leader 에서 커밋되고 serial 이 연속
    await until(async () => { await follower.store.refresh(); return follower.pendingPancakes === 0; }, 60_000);
    expect(follower.store.committedSerial).toBe(160);
    expect(follower.store.committedSerial).toBeGreaterThan(committedBefore);
    now = new Date("2026-09-18T08:09:00.000Z"); await follower.tick();
    now = new Date("2026-09-18T08:10:00.000Z"); await follower.tick();
    expect((await follower.getDrop(r1.dropId))!.status).toBe("RELEASED");
    // job 이중 실행 0: 같은 범위의 DONE job 은 하나, committed 팬케이크 160 = 할당 160, 중복 없음
    const jobs = (await dbA.query<{ start_serial: number; n: number }>("SELECT start_serial, COUNT(*)::int AS n FROM simulation_jobs WHERE status = 'DONE' GROUP BY start_serial HAVING COUNT(*) > 1")).rows;
    expect(jobs).toEqual([]);
    const done = (await dbA.query<{ n: number; lo: number; hi: number }>("SELECT COUNT(*)::int AS n, MIN(start_serial) AS lo, MAX(end_serial) AS hi FROM simulation_jobs WHERE status = 'DONE'")).rows[0];
    expect([done.lo, done.hi]).toEqual([1, 160]);
    expect((await dbA.query<{ n: number }>("SELECT COUNT(*)::int AS n FROM pancakes WHERE committed_at IS NULL")).rows[0].n).toBe(0);
    // 시도 기록: crash 로 끊긴 job 은 reclaim 되어 attempt 2 로 끝났을 수 있다 — 어떤 경우든 DONE 인 job 마다 성공 attempt 가 정확히 1개
    const attempts = (await dbA.query<{ job_id: string; n: number }>("SELECT job_id, COUNT(*)::int AS n FROM simulation_attempts WHERE status = 'DONE' GROUP BY job_id HAVING COUNT(*) <> 1")).rows;
    expect(attempts).toEqual([]);
    const ev = (await dbA.query<{ instance_id: string }>("SELECT payload->>'instanceId' AS instance_id FROM world_events WHERE type = 'leader.changed' ORDER BY event_id")).rows.map((r) => r.instance_id);
    expect(ev).toEqual([leader.instanceId, follower.instanceId]);
    await follower.stop();
  });

  it("concurrent purchases from two instances never duplicate or skip global or country serials, and idempotency holds across instances", async () => {
    const a = new WorldApp({ db: dbA, storage, config: { ...base, instanceId: "A2" }, clock: () => now });
    const b = new WorldApp({ db: dbB, storage, config: { ...base, instanceId: "B2" }, clock: () => now });
    await a.start(); await b.start();
    const before = (await dbA.query<{ s: number }>("SELECT latest_global_serial AS s FROM world_state")).rows[0].s;
    const COUNTRIES = ["KR", "JP", "US", "BR", "ID", "ZZ"];
    const ranges: { s: number; e: number }[] = [];
    const errors: string[] = [];
    const run = async (app: WorldApp, n: number): Promise<void> => { for (let w = 0; w < n / 25; w++) await Promise.all(Array.from({ length: 25 }, (_, i) => app.purchase({ quantity: 1 + (i % 4), country: COUNTRIES[(w + i) % COUNTRIES.length] }).then((r) => { ranges.push({ s: r.startSerial, e: r.endSerial }); }).catch((e) => { errors.push(String(e)); }))); };
    await Promise.all([run(a, 500), run(b, 500)]);
    expect(errors).toEqual([]);
    ranges.sort((x, y) => x.s - y.s);
    let prev = before; let total = 0;
    for (const r of ranges) { expect(r.s).toBe(prev + 1); prev = r.e; total += r.e - r.s + 1; }
    expect((await dbA.query<{ s: number }>("SELECT latest_global_serial AS s FROM world_state")).rows[0].s).toBe(before + total);
    // country serial: 국가별 1..N 연속 (중복·누락 0)
    for (const c of COUNTRIES) {
      const r = (await dbA.query<{ n: number; d: number; mx: number }>("SELECT COUNT(*)::int AS n, COUNT(DISTINCT country_serial)::int AS d, MAX(country_serial)::int AS mx FROM pancakes WHERE country = $1", [c])).rows[0];
      expect(r.d).toBe(r.n); expect(r.mx).toBe(r.n);
    }
    // idempotency: 같은 키를 두 인스턴스에 → 같은 주문
    const k = `k-${Date.now()}`;
    const [x, y] = await Promise.all([a.purchase({ quantity: 3, country: "KR", idempotencyKey: k }), b.purchase({ quantity: 3, country: "KR", idempotencyKey: k })]).catch(async () => [await a.purchase({ quantity: 3, country: "KR", idempotencyKey: k }), await b.purchase({ quantity: 3, country: "KR", idempotencyKey: k })]);
    expect(x.startSerial).toBe(y.startSerial); expect(x.orderId).toBe(y.orderId);
    await a.stop(); await b.stop();
  });
});
