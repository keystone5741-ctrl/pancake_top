import type { ChunkId } from "pancake-core";
import { TRANSFORM_STRIDE, type TowerConfig } from "./config";
import type { ChunkHeader, TowerChunk } from "./chunk";

/**
 * Binary Chunk 포맷 `.chunk` (Phase 1 §27, §28). little-endian.
 *
 * header
 *   u32 magic "PKCH"   u16 version(1)   u16 headerBytes
 *   u32 chunkId   u32 startSerial   u32 count
 *   f32×6 bounds(minX minY minZ maxX maxY maxZ)   f32 minHeight   f32 maxHeight
 *   f32 diameter   f32 thickness   f32 unitCm
 *   u8 attributeCount, 그리고 attribute 마다: u8 nameLen, ascii name, u8 type(0=f32, 1=u16), u8 components
 * body (4 byte 정렬)
 *   attribute 순서대로 typed array: transforms f32×9×count, variant u16×count, country u16×count
 * global id 는 startSerial + index 로 유도하므로 저장하지 않는다.
 */
export const CHUNK_MAGIC = 0x48434b50; // "PKCH"
export const CHUNK_VERSION = 1;

interface AttrDesc { name: string; type: 0 | 1; components: number }
const LAYOUT: AttrDesc[] = [
  { name: "transforms", type: 0, components: TRANSFORM_STRIDE },
  { name: "variant", type: 1, components: 1 },
  { name: "country", type: 1, components: 1 },
];

const align4 = (n: number): number => (n + 3) & ~3;

export function encodeChunk(chunk: TowerChunk, cfg: TowerConfig): ArrayBuffer {
  const enc = new TextEncoder();
  const names = LAYOUT.map((a) => enc.encode(a.name));
  const headerBytes = align4(4 + 2 + 2 + 4 * 3 + 4 * 8 + 4 * 3 + 1 + names.reduce((s, n) => s + 1 + n.length + 2, 0));
  let bodyBytes = 0;
  for (const a of LAYOUT) bodyBytes += align4((a.type === 0 ? 4 : 2) * a.components * chunk.count);
  const buf = new ArrayBuffer(headerBytes + bodyBytes);
  const dv = new DataView(buf);
  let o = 0;
  dv.setUint32(o, CHUNK_MAGIC, true); o += 4;
  dv.setUint16(o, CHUNK_VERSION, true); o += 2;
  dv.setUint16(o, headerBytes, true); o += 2;
  dv.setUint32(o, chunk.id, true); o += 4;
  dv.setUint32(o, chunk.startSerial, true); o += 4;
  dv.setUint32(o, chunk.count, true); o += 4;
  for (const v of [...chunk.bounds.min, ...chunk.bounds.max, chunk.minHeight, chunk.maxHeight, cfg.diameter, cfg.thickness, cfg.unitCm]) { dv.setFloat32(o, v, true); o += 4; }
  dv.setUint8(o++, LAYOUT.length);
  const u8 = new Uint8Array(buf);
  LAYOUT.forEach((a, i) => { dv.setUint8(o++, names[i].length); u8.set(names[i], o); o += names[i].length; dv.setUint8(o++, a.type); dv.setUint8(o++, a.components); });
  o = headerBytes;
  new Float32Array(buf, o, chunk.count * TRANSFORM_STRIDE).set(chunk.transforms.subarray(0, chunk.count * TRANSFORM_STRIDE)); o += align4(4 * TRANSFORM_STRIDE * chunk.count);
  new Uint16Array(buf, o, chunk.count).set(chunk.attributes.variant.subarray(0, chunk.count)); o += align4(2 * chunk.count);
  new Uint16Array(buf, o, chunk.count).set(chunk.attributes.country.subarray(0, chunk.count)); o += align4(2 * chunk.count);
  return buf;
}

export interface DecodedChunk { chunk: TowerChunk; config: Omit<TowerConfig, "chunkSize">; layout: AttrDesc[] }

export function decodeChunk(buf: ArrayBuffer): DecodedChunk {
  const dv = new DataView(buf);
  let o = 0;
  if (dv.getUint32(o, true) !== CHUNK_MAGIC) throw new Error("not a PKCH chunk"); o += 4;
  const version = dv.getUint16(o, true); o += 2;
  if (version !== CHUNK_VERSION) throw new Error(`unsupported chunk version ${version}`);
  const headerBytes = dv.getUint16(o, true); o += 2;
  const id = dv.getUint32(o, true) as ChunkId; o += 4;
  const startSerial = dv.getUint32(o, true); o += 4;
  const count = dv.getUint32(o, true); o += 4;
  const f = (): number => { const v = dv.getFloat32(o, true); o += 4; return v; };
  const bounds = { min: [f(), f(), f()] as [number, number, number], max: [f(), f(), f()] as [number, number, number] };
  const minHeight = f(), maxHeight = f(), diameter = f(), thickness = f(), unitCm = f();
  const attrCount = dv.getUint8(o++);
  const dec = new TextDecoder();
  const layout: AttrDesc[] = [];
  for (let i = 0; i < attrCount; i++) {
    const len = dv.getUint8(o++);
    const name = dec.decode(new Uint8Array(buf, o, len)); o += len;
    const type = dv.getUint8(o++) as 0 | 1;
    const components = dv.getUint8(o++);
    layout.push({ name, type, components });
  }
  o = headerBytes;
  const arrays: Record<string, Float32Array | Uint16Array> = {};
  for (const a of layout) {
    const n = a.components * count;
    if (a.type === 0) { arrays[a.name] = new Float32Array(buf.slice(o, o + 4 * n)); o += align4(4 * n); }
    else { arrays[a.name] = new Uint16Array(buf.slice(o, o + 2 * n)); o += align4(2 * n); }
  }
  const transforms = arrays.transforms as Float32Array | undefined;
  if (!transforms) throw new Error("chunk has no transforms attribute");
  const chunk: TowerChunk = {
    id, startSerial, endSerial: startSerial + count - 1, count, bounds, minHeight, maxHeight, transforms,
    attributes: { variant: (arrays.variant as Uint16Array | undefined) ?? new Uint16Array(count), country: (arrays.country as Uint16Array | undefined) ?? new Uint16Array(count).fill(675) },
  };
  return { chunk, config: { diameter, thickness, unitCm }, layout };
}

/** Tower manifest: chunk header 목록 + 설정. 클라이언트는 이것으로 높이·인덱스·가시성을 알고 chunk 파일을 나중에 받는다. */
export interface TowerManifest { version: 1; config: TowerConfig; totalCount: number; headers: ChunkHeader[] }
export function makeManifest(config: TowerConfig, headers: readonly ChunkHeader[]): TowerManifest {
  return { version: 1, config, totalCount: headers.reduce((a, h) => a + h.count, 0), headers: headers.map((h) => ({ ...h })) };
}
