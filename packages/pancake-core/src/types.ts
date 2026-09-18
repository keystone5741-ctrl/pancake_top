/**
 * PANCAKE DROP 공용 타입 (플랜 §33).
 * 모든 팬케이크는 고유 ID·transform·국가·variant·chunk·물리 상태를 가진 독립 객체다 (Phase 1 §0).
 */

/** Global serial. 0 부터 시작하는 정수. 표시할 때는 #1 부터. */
export type PancakeId = number;
/** Drop batch id, 예: DROP_20260917_0620UTC */
export type DropId = string;
/** chunk 번호 = floor(id / chunkSize) */
export type ChunkId = number;
/** ISO 3166-1 alpha-2, 예: "KR". 미선택은 "ZZ". */
export type CountryCode = string;
/** 팬케이크 외형 variant. 0 = Classic. */
export type VariantId = number;

export type PhysicsState = "ACTIVE" | "SURFACE" | "FROZEN";

export interface PancakeTransform {
  position: [number, number, number];
  quaternion: [number, number, number, number];
  /** 직경 배율 */
  scale: number;
  /** 두께 배율 */
  thicknessScale: number;
}

export interface PancakeMetadata {
  id: PancakeId;
  country: CountryCode;
  variant: VariantId;
  dropId: DropId | null;
  chunkId: ChunkId;
  instanceIndex: number;
  physicsState: PhysicsState;
}

/**
 * 서버가 확정한 팬케이크 집합의 transform (Structure of Arrays).
 * 서버 → 클라이언트로 전달되는 유일한 물리 결과다 (플랜 §8). index = id - startSerial.
 */
export interface PancakeTransformSet {
  count: number;
  /** 이 집합의 첫 팬케이크 global id */
  startSerial?: number;
  diameter: number;
  thickness: number;
  unitCm: number;
  px: Float32Array; py: Float32Array; pz: Float32Array;
  qx: Float32Array; qy: Float32Array; qz: Float32Array; qw: Float32Array;
  scale: Float32Array; tscale: Float32Array;
  /** 선택 속성. 없으면 variant 0 / country "ZZ" 로 간주 */
  variant?: Uint16Array;
  country?: Uint16Array;
}

/** 이전 이름과의 호환 */
export type TowerData = PancakeTransformSet;

export function emptyTransformSet(count: number, diameter: number, thickness: number, unitCm: number, startSerial = 0): PancakeTransformSet {
  const mk = (): Float32Array => new Float32Array(count);
  return { count, startSerial, diameter, thickness, unitCm, px: mk(), py: mk(), pz: mk(), qx: mk(), qy: mk(), qz: mk(), qw: mk(), scale: mk().fill(1), tscale: mk().fill(1) };
}

/** 국가 코드 ↔ uint16 (binary chunk 저장용). "AA" = 0 … "ZZ" = 675. */
export function encodeCountry(code: CountryCode): number {
  const c = code.toUpperCase();
  if (c.length !== 2) return 675;
  const a = c.charCodeAt(0) - 65, b = c.charCodeAt(1) - 65;
  if (a < 0 || a > 25 || b < 0 || b > 25) return 675;
  return a * 26 + b;
}
export function decodeCountry(v: number): CountryCode {
  if (v < 0 || v > 675) return "ZZ";
  return String.fromCharCode(65 + Math.floor(v / 26), 65 + (v % 26));
}
