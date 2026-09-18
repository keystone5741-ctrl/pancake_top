import { emptyTransformSet, type PancakeTransformSet } from "pancake-core";
import type { TowerConfig } from "./config";

/** mulberry32 (pancake-physics 와 같은 알고리즘, 의존성 없이 복제) */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/**
 * 물리 없이 절차적으로 쌓은 합성 탑 (Phase 0.75/1 구조 검증용). Phase 0.75 프로토타입과 같은 규칙.
 * 실제 서비스 탑은 항상 서버 물리 결과에서 온다. 이것은 렌더링/인덱스/메모리 검증 전용이다.
 */
export function generateSyntheticTower(n: number, cfg: TowerConfig, seed = 42, startSerial = 0): PancakeTransformSet {
  const r = rng(seed);
  const t = emptyTransformSet(n, cfg.diameter, cfg.thickness, cfg.unitCm, startSerial);
  t.variant = new Uint16Array(n);
  t.country = new Uint16Array(n).fill(675);
  let x = 0, z = 0, y = 0;
  for (let i = 0; i < n; i++) {
    x = x * 0.9 + (r() - 0.5) * 0.2; z = z * 0.9 + (r() - 0.5) * 0.2;
    const ts = 1 + (r() - 0.5) * 0.2;
    y += cfg.thickness * ts;
    t.px[i] = x; t.py[i] = y - (cfg.thickness * ts) / 2; t.pz[i] = z;
    const yaw = r() * Math.PI * 2, tilt = (r() - 0.5) * 0.1, ax = r() * Math.PI * 2;
    const sy = Math.sin(yaw / 2), cy = Math.cos(yaw / 2), st = Math.sin(tilt / 2), ct = Math.cos(tilt / 2);
    const tx = Math.cos(ax) * st, tz = Math.sin(ax) * st;
    t.qx[i] = cy * tx + sy * tz; t.qy[i] = sy * ct; t.qz[i] = cy * tz - sy * tx; t.qw[i] = cy * ct;
    t.scale[i] = 1 + (r() - 0.5) * 0.1; t.tscale[i] = ts;
  }
  return t;
}
