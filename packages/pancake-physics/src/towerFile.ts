/**
 * 서버 결과(최종 Transform) 바이너리 포맷 — 플랜 §34 Chunk Binary 의 Phase 0.5 축소판.
 * 서버가 계산한 값만 담는다: id(=index), position, quaternion, scale, tscale.
 * 클라이언트는 이것을 읽어 렌더링/연출만 한다 (§7 분리 검증).
 *
 * layout: "PKT1" | uint32 count | float32 diameter | float32 thickness | float32 unitCm | count × 9 float32
 */
export const TOWER_MAGIC = 0x31544b50; // "PKT1" little-endian
export const FLOATS_PER_PANCAKE = 9;

import type { TowerData } from "pancake-core";

export function encodeTower(t: TowerData): ArrayBuffer {
  const header = 16;
  const buf = new ArrayBuffer(header + t.count * FLOATS_PER_PANCAKE * 4);
  const dv = new DataView(buf);
  dv.setUint32(0, TOWER_MAGIC, true);
  dv.setUint32(4, t.count, true);
  dv.setFloat32(8, t.diameter, true);
  dv.setFloat32(12, t.thickness, true);
  const f = new Float32Array(buf, header);
  for (let i = 0; i < t.count; i++) {
    const o = i * FLOATS_PER_PANCAKE;
    f[o] = t.px[i]; f[o + 1] = t.py[i]; f[o + 2] = t.pz[i];
    f[o + 3] = t.qx[i]; f[o + 4] = t.qy[i]; f[o + 5] = t.qz[i]; f[o + 6] = t.qw[i];
    f[o + 7] = t.scale[i]; f[o + 8] = t.tscale[i];
  }
  return buf;
}

export function decodeTower(buf: ArrayBuffer, unitCm = 10): TowerData {
  const dv = new DataView(buf);
  if (dv.getUint32(0, true) !== TOWER_MAGIC) throw new Error("not a PKT1 tower file");
  const count = dv.getUint32(4, true);
  const diameter = dv.getFloat32(8, true);
  const thickness = dv.getFloat32(12, true);
  const f = new Float32Array(buf, 16, count * FLOATS_PER_PANCAKE);
  const mk = (): Float32Array => new Float32Array(count);
  const t: TowerData = { count, diameter, thickness, unitCm, px: mk(), py: mk(), pz: mk(), qx: mk(), qy: mk(), qz: mk(), qw: mk(), scale: mk(), tscale: mk() };
  for (let i = 0; i < count; i++) {
    const o = i * FLOATS_PER_PANCAKE;
    t.px[i] = f[o]; t.py[i] = f[o + 1]; t.pz[i] = f[o + 2];
    t.qx[i] = f[o + 3]; t.qy[i] = f[o + 4]; t.qz[i] = f[o + 5]; t.qw[i] = f[o + 6];
    t.scale[i] = f[o + 7]; t.tscale[i] = f[o + 8];
  }
  return t;
}
