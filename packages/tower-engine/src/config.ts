import { DEFAULT_UNIT_CM } from "pancake-core";

/** Tower Engine 설정. chunkSize 는 상수가 아니라 설정값이다 (Phase 1 §3). */
export interface TowerConfig {
  chunkSize: number;
  /** 팬케이크 공칭 직경 / 두께 (world units) */
  diameter: number;
  thickness: number;
  unitCm: number;
}

export const DEFAULT_TOWER_CONFIG: TowerConfig = {
  chunkSize: 10_000,
  diameter: 1.0,
  thickness: 0.1,
  unitCm: DEFAULT_UNIT_CM,
};

/** transforms Float32Array 의 팬케이크당 float 수: px py pz qx qy qz qw scale tscale */
export const TRANSFORM_STRIDE = 9;
