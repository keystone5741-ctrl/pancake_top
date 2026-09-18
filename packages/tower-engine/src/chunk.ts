import type { ChunkId, PancakeTransformSet } from "pancake-core";
import { TRANSFORM_STRIDE, type TowerConfig } from "./config";

/** Three.js 에 의존하지 않는 AABB */
export interface Bounds3 {
  min: [number, number, number];
  max: [number, number, number];
}

export interface ChunkAttributes {
  variant: Uint16Array;
  country: Uint16Array;
}

/**
 * Chunk 스트리밍 상태 (Phase 1 §5).
 * UNLOADED: transform 없음 / CPU_READY: transform 있음, GPU 없음 / GPU_LOW: far LOD 만 / GPU_HIGH: 모든 LOD.
 */
export type ChunkState = "UNLOADED" | "CPU_READY" | "GPU_LOW" | "GPU_HIGH";

/** transform 없이도 알 수 있는 chunk 요약. 서버가 chunk 파일과 함께 제공한다. 높이·가시성 판정의 근거. */
export interface ChunkHeader {
  id: ChunkId;
  startSerial: number;
  /** 마지막 serial (포함) */
  endSerial: number;
  count: number;
  bounds: Bounds3;
  /** 가장 낮은 팬케이크 바닥 / 가장 높은 팬케이크 윗면 (world units) */
  minHeight: number;
  maxHeight: number;
  /** 서버가 준 chunk 바이너리의 SHA-256 (hex). 없으면 검증 생략. */
  checksum?: string;
}

export interface TowerChunk extends ChunkHeader {
  /** stride 9: px py pz qx qy qz qw scale tscale */
  transforms: Float32Array;
  attributes: ChunkAttributes;
}

export function chunkIdOf(serial: number, chunkSize: number): ChunkId {
  return Math.floor(serial / chunkSize);
}
export function instanceIndexOf(serial: number, chunkSize: number): number {
  return serial - chunkIdOf(serial, chunkSize) * chunkSize;
}
export function serialOf(chunkId: ChunkId, instanceIndex: number, chunkSize: number): number {
  return chunkId * chunkSize + instanceIndex;
}

/** PancakeTransformSet 의 [from, to) 구간을 하나의 chunk 로 만든다. */
export function buildChunk(set: PancakeTransformSet, id: ChunkId, from: number, to: number, cfg: TowerConfig): TowerChunk {
  const count = to - from;
  const transforms = new Float32Array(count * TRANSFORM_STRIDE);
  const variant = new Uint16Array(count);
  const country = new Uint16Array(count);
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < count; i++) {
    const s = from + i;
    const o = i * TRANSFORM_STRIDE;
    transforms[o] = set.px[s]; transforms[o + 1] = set.py[s]; transforms[o + 2] = set.pz[s];
    transforms[o + 3] = set.qx[s]; transforms[o + 4] = set.qy[s]; transforms[o + 5] = set.qz[s]; transforms[o + 6] = set.qw[s];
    transforms[o + 7] = set.scale[s]; transforms[o + 8] = set.tscale[s];
    variant[i] = set.variant ? set.variant[s] : 0;
    country[i] = set.country ? set.country[s] : 675;
    // bounds: XZ 는 보수적으로(반지름·반두께의 대각), Y 는 기울어진 원기둥의 정확한 수직 범위
    //   vert = r·sin(tilt) + h·cos(tilt),  cos(tilt) = up.y = 1 - 2(qx² + qz²)
    // maxHeight 가 곧 탑 높이의 source of truth 이므로 Y 는 정확해야 한다.
    const r = (cfg.diameter * set.scale[s]) / 2;
    const h = (cfg.thickness * set.tscale[s]) / 2;
    const e = Math.hypot(r, h);
    const uy = Math.abs(1 - 2 * (set.qx[s] * set.qx[s] + set.qz[s] * set.qz[s]));
    const vert = r * Math.sqrt(Math.max(0, 1 - uy * uy)) + h * uy;
    minX = Math.min(minX, set.px[s] - e); maxX = Math.max(maxX, set.px[s] + e);
    minZ = Math.min(minZ, set.pz[s] - e); maxZ = Math.max(maxZ, set.pz[s] + e);
    minY = Math.min(minY, set.py[s] - vert); maxY = Math.max(maxY, set.py[s] + vert);
  }
  const startSerial = (set.startSerial ?? 0) + from;
  return {
    id, startSerial, endSerial: startSerial + count - 1, count,
    bounds: count ? { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] } : { min: [0, 0, 0], max: [0, 0, 0] },
    minHeight: count ? minY : 0,
    maxHeight: count ? maxY : 0,
    transforms,
    attributes: { variant, country },
  };
}

export function headerOf(c: TowerChunk): ChunkHeader {
  const { id, startSerial, endSerial, count, bounds, minHeight, maxHeight } = c;
  return { id, startSerial, endSerial, count, bounds, minHeight, maxHeight };
}

/** 한 chunk 에서 instance 의 transform 을 읽는다 */
export function readTransform(c: TowerChunk, instanceIndex: number): { position: [number, number, number]; quaternion: [number, number, number, number]; scale: number; thicknessScale: number } {
  const o = instanceIndex * TRANSFORM_STRIDE;
  const t = c.transforms;
  return { position: [t[o], t[o + 1], t[o + 2]], quaternion: [t[o + 3], t[o + 4], t[o + 5], t[o + 6]], scale: t[o + 7], thicknessScale: t[o + 8] };
}

/** chunk 의 GPU instance 메모리 추정 (행렬 16 float + 색 3 float, LOD 단계 수 만큼 버퍼가 있을 수 있음) */
export function estimateInstanceBytes(count: number, lodBuffers = 1): number {
  return count * (16 + 3) * 4 * lodBuffers;
}
