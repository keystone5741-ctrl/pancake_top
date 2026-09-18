import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WorldApp } from "../src/app";
import { loadConfig } from "../src/config";
import type { Db } from "../src/db/db";
import { createHttpServer } from "../src/http/server";
import { MemoryChunkStorage } from "../src/world/chunkStorage";
import { freshDb } from "./helpers";

/** FAILED Drop 복구 API (Phase 3A §14~§16) */
let db: Db;
let app: WorldApp;
let base = "";
let server: ReturnType<typeof createHttpServer>["server"];
const storage = new MemoryChunkStorage();
let now = new Date("2026-09-18T09:02:00.000Z");
const cfg = loadConfig({ chunkSize: 100, simBatchSize: 30, simBatchWindowMs: 0, queueThrottleMs: 20, snapshotEveryPancakes: 1e9, workerMaxAttempts: 2, adminSecret: "s3cret", instanceId: "adm" });
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const until = async (fn: () => boolean | Promise<boolean>, ms = 60_000): Promise<void> => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return; app.kick(); await wait(50); } throw new Error("timeout"); };
const api = async (method: string, path: string, secret = "s3cret"): Promise<{ status: number; body: any }> => { const r = await fetch(base + path, { method, headers: secret ? { "x-admin-secret": secret } : {} }); return { status: r.status, body: await r.json() }; };

beforeAll(async () => {
  db = await freshDb();
  app = new WorldApp({ db, storage, config: cfg, clock: () => now, cluster: false });
  await app.start();
  server = createHttpServer(app).server;
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => { server.close(); await app.stop(); await db.close(); });

describe("admin recovery API", () => {
  it("three storage failures → drop FAILED with STORAGE_FAILED and full attempt history; retry resumes and completes the drop", async () => {
    await app.purchase({ quantity: 50, country: "KR" });
    await until(async () => { await app.store.refresh(); return app.store.committedSerial >= 30; });
    // 다음 job 의 업로드가 계속 실패하게
    let fails = 0;
    const origPut = storage.put.bind(storage);
    storage.put = async () => { fails++; throw new Error(`injected upload failure #${fails}`); };
    await until(() => app.pipelineHalted, 60_000);
    storage.put = origPut;
    const d = (await app.getDrop("drop_20260918T091000Z"))!;
    expect(d.status).toBe("FAILED");
    expect(d.failure_reason).toBe("STORAGE_FAILED");
    expect(fails).toBe(cfg.workerMaxAttempts);
    const failed = await api("GET", "/api/admin/drops/failed");
    expect(failed.status).toBe(200);
    expect(failed.body.pipelineHalted).toBe(true);
    expect(failed.body.drops[0].drop_id).toBe(d.drop_id);
    const job = failed.body.drops[0].jobs[0];
    expect(job.status).toBe("FAILED");
    expect(job.failure_reason).toBe("STORAGE_FAILED");
    expect(job.attempts.length).toBe(cfg.workerMaxAttempts);
    expect(job.attempts.every((a: { status: string; failure_reason: string }) => a.status === "FAILED" && a.failure_reason === "STORAGE_FAILED")).toBe(true);
    // 인증 없이는 401
    expect((await api("GET", "/api/admin/drops/failed", "")).status).toBe(401);
    expect((await api("POST", `/api/admin/drops/${d.drop_id}/retry`, "wrong")).status).toBe(401);
    // retry → 이어서 완료, 시도 기록은 그대로 + 성공 attempt 추가
    const r = await api("POST", `/api/admin/drops/${d.drop_id}/retry`);
    expect(r.status).toBe(200); expect(r.body.jobs).toBe(1);
    await until(async () => { await app.store.refresh(); return app.pendingPancakes === 0; });
    expect(app.pipelineHalted).toBe(false);
    const attempts = (await db.query<{ status: string }>("SELECT status FROM simulation_attempts WHERE job_id = $1 ORDER BY attempt", [job.job_id])).rows.map((x) => x.status);
    expect(attempts).toEqual([...Array(cfg.workerMaxAttempts).fill("FAILED"), "DONE"]);
    expect((await db.query<{ n: number }>("SELECT COUNT(*)::int AS n FROM pancakes WHERE committed_at IS NULL")).rows[0].n).toBe(0);
    now = new Date("2026-09-18T09:09:00.000Z"); await app.tick();
    now = new Date("2026-09-18T09:10:00.000Z"); await app.tick();
    expect((await app.getDrop(d.drop_id))!.status).toBe("RELEASED");
    expect((await api("POST", `/api/admin/drops/${d.drop_id}/retry`)).status).toBe(409); // FAILED 가 아니면 거부
    const ev = (await db.query<{ type: string }>("SELECT type FROM world_events WHERE type IN ('drop.failed','drop.recovered') ORDER BY event_id")).rows.map((x) => x.type);
    expect(ev).toEqual(["drop.failed", "drop.recovered"]);
  });

  it("abort moves the failed drop's pending pancakes to the current drop and the pipeline continues there", async () => {
    now = new Date("2026-09-18T09:12:00.000Z");
    await app.purchase({ quantity: 40, country: "JP" });
    const dropId = "drop_20260918T092000Z";
    const origPut = storage.put.bind(storage);
    storage.put = async () => { throw new Error("injected"); };
    await until(() => app.pipelineHalted, 60_000);
    storage.put = origPut;
    expect((await app.getDrop(dropId))!.status).toBe("FAILED");
    now = new Date("2026-09-18T09:21:00.000Z"); // 다음 Drop 시간대
    const r = await api("POST", `/api/admin/drops/${dropId}/abort`);
    expect(r.status).toBe(200);
    expect(r.body.moved).toBeGreaterThan(0);
    expect(r.body.toDropId).toBe("drop_20260918T093000Z");
    await until(async () => { await app.store.refresh(); return app.pendingPancakes === 0; });
    const old = (await app.getDrop(dropId))!;
    expect(old.status).toBe("FAILED"); expect(old.aborted_at).not.toBeNull();
    expect((await db.query<{ n: number }>("SELECT COUNT(*)::int AS n FROM pancakes WHERE drop_id = $1 AND committed_at IS NULL", [dropId])).rows[0].n).toBe(0);
    expect((await db.query<{ n: number }>("SELECT COUNT(*)::int AS n FROM pancakes WHERE drop_id = $1", ["drop_20260918T093000Z"])).rows[0].n).toBe(r.body.moved);
    // 옮겨간 팬케이크는 serial 이 그대로이고 커밋됐다
    const gap = (await db.query<{ n: number }>("SELECT COUNT(*)::int AS n FROM pancakes WHERE committed_at IS NULL")).rows[0].n;
    expect(gap).toBe(0);
  });
});
