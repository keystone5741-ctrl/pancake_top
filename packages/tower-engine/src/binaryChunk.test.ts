import { describe, expect, it } from "vitest";
import { DEFAULT_TOWER_CONFIG, MemoryChunkSource, Tower, UrlChunkSource, decodeChunk, encodeChunk, generateSyntheticTower, makeManifest, chunkToTransformSet, concatTransformSets } from "./index";

const cfg = { ...DEFAULT_TOWER_CONFIG, chunkSize: 1000 };

describe("binary chunk", () => {
  it("round-trips a chunk and equals the JSON transform dump", () => {
    const set = generateSyntheticTower(2500, cfg, 5);
    set.variant![3] = 7; set.country![3] = 262; // "KC"
    const src = new MemoryChunkSource(set, cfg);
    for (const h of src.headers) {
      const chunk = src.peek(h.id)!;
      const buf = encodeChunk(chunk, cfg);
      const { chunk: d, config } = decodeChunk(buf);
      expect(d.id).toBe(chunk.id);
      expect(d.startSerial).toBe(chunk.startSerial);
      expect(d.endSerial).toBe(chunk.endSerial);
      expect(d.count).toBe(chunk.count);
      for (let k = 0; k < 3; k++) { expect(d.bounds.min[k]).toBeCloseTo(chunk.bounds.min[k], 4); expect(d.bounds.max[k]).toBeCloseTo(chunk.bounds.max[k], 4); } // f32 저장
      expect(d.minHeight).toBeCloseTo(chunk.minHeight, 5);
      expect(d.maxHeight).toBeCloseTo(chunk.maxHeight, 5);
      expect(config.diameter).toBeCloseTo(cfg.diameter, 6); expect(config.thickness).toBeCloseTo(cfg.thickness, 6); expect(config.unitCm).toBeCloseTo(cfg.unitCm, 6);
      // JSON dump 와 동일
      expect(JSON.parse(JSON.stringify(Array.from(d.transforms)))).toEqual(JSON.parse(JSON.stringify(Array.from(chunk.transforms))));
      expect(Array.from(d.attributes.variant)).toEqual(Array.from(chunk.attributes.variant));
      expect(Array.from(d.attributes.country)).toEqual(Array.from(chunk.attributes.country));
      expect(buf.byteLength).toBeLessThan(chunk.count * (36 + 4) + 128);
    }
  });
  it("rejects foreign buffers", () => {
    expect(() => decodeChunk(new ArrayBuffer(64))).toThrow();
  });
  it("streams through a manifest + url source and finds pancakes after async load", async () => {
    const set = generateSyntheticTower(2500, cfg, 5);
    const mem = new MemoryChunkSource(set, cfg);
    const files = new Map<string, ArrayBuffer>();
    for (const h of mem.headers) files.set(`/c/${h.id}.chunk`, encodeChunk(mem.peek(h.id)!, cfg));
    const manifest = makeManifest(cfg, mem.headers);
    let fetches = 0;
    const src = new UrlChunkSource(manifest, (id) => `/c/${id}.chunk`, async (u) => { fetches++; const b = files.get(u); if (!b) throw new Error("404"); return b; });
    const tower = new Tower(src);
    expect(tower.count).toBe(2500);
    expect(tower.height).toBeCloseTo(new Tower(mem).height, 5);
    expect(tower.findPancake(1500)).toBeNull(); // 아직 로드 안 됨 (peek 없음)
    const r = await tower.findPancakeAsync(1500);
    expect(r?.worldPosition).toEqual([set.px[1500], set.py[1500], set.pz[1500]]);
    await tower.findPancakeAsync(1501);
    expect(fetches).toBe(1);
  });
  it("appends a transform set into the last partial chunk and new chunks", () => {
    const a = generateSyntheticTower(1500, cfg, 5);
    const src = new MemoryChunkSource(a, cfg);
    const tower = new Tower(src);
    tower.loadChunkSync(1);
    const b = generateSyntheticTower(1200, cfg, 6, 1500);
    const changed = src.append(b);
    expect(changed).toEqual([1, 2]);
    tower.refresh(changed);
    expect(tower.count).toBe(2700);
    expect(tower.chunkCount).toBe(3);
    expect(tower.state(1)).toBe("UNLOADED");
    const r = tower.findPancake(1500)!;
    expect(r.chunkId).toBe(1); expect(r.instanceIndex).toBe(500);
    expect(r.worldPosition).toEqual([b.px[0], b.py[0], b.pz[0]]);
    expect(tower.findPancake(2699)!.chunkId).toBe(2);
    const back = chunkToTransformSet(src.peek(1)!, cfg);
    expect(back.count).toBe(1000);
    expect(back.px[499]).toBe(a.px[1499]);
    expect(concatTransformSets(a, b).count).toBe(2700);
  });
});
