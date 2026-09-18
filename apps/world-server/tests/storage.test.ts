import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import S3rver from "s3rver";
import { WorldApp } from "../src/app";
import { loadConfig } from "../src/config";
import type { Db } from "../src/db/db";
import { LocalChunkStorage, MemoryChunkStorage, ObjectChunkStorage, chunkKey, stagingKey, type ChunkStorage } from "../src/world/chunkStorage";
import { WorldStore, sha256 } from "../src/world/worldStore";
import { freshDb } from "./helpers";

let s3: S3rver; let dir: string; let port = 0;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "pancake-s3-"));
  s3 = new S3rver({ port: 0, address: "127.0.0.1", silent: true, directory: dir, configureBuckets: [{ name: "pancake-test" }] } as never);
  const addr = await s3.run();
  port = (addr as { port: number }).port;
});
afterAll(async () => { await s3.close(); rmSync(dir, { recursive: true, force: true }); });

const objectStorage = (prefix = ""): ObjectChunkStorage => new ObjectChunkStorage({ endpoint: `http://127.0.0.1:${port}`, bucket: "pancake-test", region: "us-east-1", accessKeyId: "S3RVER", secretAccessKey: "S3RVER", prefix, forcePathStyle: true, maxRetries: 1 });

describe("ChunkStorage adapters (S3-compatible / local / memory)", () => {
  const cases: [string, () => ChunkStorage][] = [
    ["object (s3rver, SigV4)", () => objectStorage("t1/")],
    ["local", () => new LocalChunkStorage(mkdtempSync(join(tmpdir(), "pancake-local-")))],
    ["memory", () => new MemoryChunkStorage()],
  ];
  for (const [name, make] of cases) {
    it(`${name}: put/get/head/exists/list/copy/delete with sha256 metadata`, async () => {
      const st = make();
      const data = new Uint8Array(1000); for (let i = 0; i < data.length; i++) data[i] = (i * 31) & 255;
      const sha = sha256(data);
      const k1 = stagingKey("w", 7, 3), k2 = chunkKey("w", 7, 3);
      expect(await st.exists(k1)).toBe(false);
      expect(await st.head(k1)).toBeNull();
      expect(await st.get(k1)).toBeNull();
      await st.put(k1, data, { sha256: sha });
      const h = await st.head(k1);
      expect(h!.size).toBe(1000);
      if (h!.sha256 !== null) expect(h!.sha256).toBe(sha);
      expect(sha256((await st.get(k1))!)).toBe(sha);
      await st.copy(k1, k2);
      expect(sha256((await st.get(k2))!)).toBe(sha);
      expect(await st.list("worlds/w/")).toEqual([k2, k1].sort());
      expect(await st.list("worlds/w/staging/")).toEqual([k1]);
      await st.delete(k1);
      expect(await st.exists(k1)).toBe(false);
      expect(await st.list("worlds/w/")).toEqual([k2]);
      await st.delete(k1); // idempotent
    });
  }
  it("object: keys with 1000+ objects are listed across continuation pages", async () => {
    const st = objectStorage("t2/");
    for (let b = 0; b < 1100; b += 50) await Promise.all(Array.from({ length: 50 }, (_, j) => st.put(`worlds/big/chunks/${String(b + j).padStart(6, "0")}-v1.chunk`, new Uint8Array([(b + j) & 255]))));
    const keys = await st.list("worlds/big/");
    expect(keys.length).toBe(1100);
    expect(keys[0]).toBe("worlds/big/chunks/000000-v1.chunk");
  });
  it("object: 4xx errors surface as ObjectStorageError, missing bucket fails", async () => {
    const bad = new ObjectChunkStorage({ endpoint: `http://127.0.0.1:${port}`, bucket: "no-such-bucket", region: "us-east-1", accessKeyId: "a", secretAccessKey: "b", maxRetries: 0 });
    await expect(bad.put("x", new Uint8Array(1))).rejects.toThrow(/HTTP 40[34]/);
  });
});

describe("world commit on object storage", () => {
  let db: Db;
  beforeAll(async () => { db = await freshDb(); });
  afterAll(async () => { await db.close(); });

  it("writes staging → verifies → commits → promotes finalized chunks to immutable keys; failures never bump the version", async () => {
    const storage = objectStorage("world1/");
    const cfg = loadConfig({ chunkSize: 100, simBatchSize: 50, simBatchWindowMs: 0, queueThrottleMs: 20, snapshotEveryPancakes: 1e9 });
    const now = new Date("2026-09-18T06:01:00.000Z");
    const app = new WorldApp({ db, storage, config: cfg, clock: () => now });
    await app.start();
    await app.purchase({ quantity: 230, country: "KR" });
    const t0 = Date.now();
    while (Date.now() - t0 < 120_000) { await app.store.refresh(); if (app.pendingPancakes === 0) break; app.kick(); await new Promise((r) => setTimeout(r, 100)); }
    expect(app.pendingPancakes).toBe(0);
    const m = await app.store.manifest();
    expect(m.chunks.map((c) => c.finalized)).toEqual([true, true, false]);
    for (const c of m.chunks) {
      expect(c.storageKey).toBe(c.finalized ? chunkKey("world", c.id, c.finalized ? Number(/-v(\d+)/.exec(c.storageKey!)![1]) : 0) : c.storageKey);
      expect(c.storageKey!.includes(c.finalized ? "/chunks/" : "/staging/")).toBe(true);
      const bytes = await storage.get(c.storageKey!);
      expect(sha256(bytes!)).toBe(c.sha256);
      expect((await storage.head(c.storageKey!))!.sha256).toBe(c.sha256);
    }
    // 저장소에 참조 안 되는 객체(이전 staging 버전)가 남지 않는다
    expect((await storage.list("worlds/world/")).sort()).toEqual(m.chunks.map((c) => c.storageKey!).sort());
    const v = app.store.version;
    // 업로드 실패 → STORAGE_FAILED, version 그대로
    const failing = new Proxy(storage, { get(t, k) { if (k === "put") return async () => { throw new Error("injected 503"); }; return Reflect.get(t, k); } });
    const store2 = new WorldStore(db, failing as ChunkStorage, cfg);
    await store2.load();
    const { emptyTransformSet } = await import("pancake-core");
    const set = emptyTransformSet(5, 1, 0.1, 10, 0); for (let i = 0; i < 5; i++) { set.py[i] = 1 + i * 0.1; set.qw[i] = 1; set.scale[i] = 1; set.tscale[i] = 1; }
    const input = { jobId: "jx", dropId: "d", startSerial: 231, endSerial: 235, finalTransforms: { ...set }, heightUnits: 2, countries: new Uint16Array(5) };
    await expect(store2.commit(input)).rejects.toMatchObject({ reason: "STORAGE_FAILED" });
    // verify 불일치 → CORRUPTED_CHUNK, version 그대로
    const lying = new Proxy(storage, { get(t, k) { if (k === "head") return async (key: string) => { const h = await t.head(key); return h ? { ...h, size: h.size + 1 } : h; }; return Reflect.get(t, k); } });
    const store3 = new WorldStore(db, lying as ChunkStorage, cfg);
    await store3.load();
    await expect(store3.commit(input)).rejects.toMatchObject({ reason: "CORRUPTED_CHUNK" });
    await app.store.refresh();
    expect(app.store.version).toBe(v);
    // 재시작 reconcile: 실패한 시도가 남긴 staging 객체를 지우고, 손상된 객체를 DB 에서 복원한다
    await storage.put(m.chunks[0].storageKey!, new Uint8Array([1, 2, 3]), { sha256: "bad" });
    await app.stop();
    const app2 = new WorldApp({ db, storage, config: cfg, clock: () => now });
    await app2.start();
    expect(app2.store.metrics.recoveredFiles).toBeGreaterThanOrEqual(1);
    expect(sha256((await storage.get(m.chunks[0].storageKey!))!)).toBe(m.chunks[0].sha256);
    expect((await storage.list("worlds/world/")).sort()).toEqual(m.chunks.map((c) => c.storageKey!).sort());
    await app2.stop();
  });
});
