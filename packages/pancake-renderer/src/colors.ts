import * as THREE from "three";
import type { TowerChunk } from "tower-engine";

function hash(i: number): number {
  let x = (i + 1) * 2654435761;
  x = ((x >>> 16) ^ x) * 0x45d9f3b;
  x = ((x >>> 16) ^ x) >>> 0;
  return (x % 100000) / 100000;
}

/** 팬케이크 기본색 + 개체별 굽기/색상 편차 (플랜 §4). variant 별 팔레트는 Phase 1 범위 밖이라 Classic 하나. */
export function chunkBaseColors(chunk: TowerChunk): Float32Array {
  const out = new Float32Array(chunk.count * 3);
  const base = new THREE.Color("#d9a15c");
  const hsl = { h: 0, s: 0, l: 0 };
  base.getHSL(hsl);
  const c = new THREE.Color();
  for (let i = 0; i < chunk.count; i++) {
    const id = chunk.startSerial + i;
    c.setHSL(hsl.h + (hash(id) - 0.5) * 0.02, hsl.s + (hash(id + 1) - 0.5) * 0.15, hsl.l + (hash(id + 2) - 0.5) * 0.18);
    out[i * 3] = c.r; out[i * 3 + 1] = c.g; out[i * 3 + 2] = c.b;
  }
  return out;
}
