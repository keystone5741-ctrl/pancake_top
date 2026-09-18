/**
 * 단위: 1 world unit = UNIT_CM cm. 기본 10 cm (= 팬케이크 직경 1.0, 두께 0.1).
 * Rapier의 기본 허용 오차(0.001)가 1 mm 실제 오차가 되도록 스케일을 맞춘 것이다.
 * 1 unit = 1 m 로 두면 두께 1 cm 객체에 대해 오차/예측 거리가 너무 커진다.
 */
export interface SimConfig {
  unitCm: number;
  diameter: number;
  thickness: number;
  /** 크기 편차 (±비율) */
  sizeJitter: number;
  /** 두께 편차 (±비율) */
  thicknessJitter: number;
  gravity: number;
  friction: number;
  restitution: number;
  angularDamping: number;
  linearDamping: number;
  density: number;
  /** 한 Drop(배치)에 떨어뜨리는 개수 */
  batchSize: number;
  /** 한 물리 step마다 스폰하는 개수 (배치를 흘려보내는 속도) */
  spawnPerStep: number;
  /** 스폰 XZ 반경 (units) */
  spawnSpread: number;
  /** 스폰 시 기울기 (rad) */
  spawnTilt: number;
  /** 'top' 스폰 모드에서 탑 축 쪽으로 되돌리는 비율 (0 = 순수 random walk, 1 = 항상 축 위) */
  spawnRecenter: number;
  /** 탑 최고점 위 스폰 여유 높이 (units) */
  spawnClearance: number;
  /** 정착 판정: 선속도/각속도 임계값과 유지 프레임 수 */
  settleLinVel: number;
  settleAngVel: number;
  settleFrames: number;
  /** 묻힘 판정 깊이 (units). 중심 셀의 최고점이 이 값 이상 위에 있으면 FROZEN */
  freezeDepth: number;
  freezeEnabled: boolean;
  /**
   * FROZEN 전환 시 Rapier body 처리.
   *  remove: 즉시 removeRigidBody (Phase 0/0.5 방식; Rapier 0.20 패닉 위험)
   *  deferRemove: 다음 world.step 직전에 제거 (역시 패닉 위험)
   *  disable: 제거하지 않고 setEnabled(false) (크래시 없음, body 누적으로 대형 Drop 에서 2배 느림)
   *  rebuild: setEnabled(false) 후 활성 강체가 0 인 배치 경계에서 월드 재생성 (크래시 없음, 속도 유지) — 기본값
   */
  freezeMode: "remove" | "deferRemove" | "disable" | "rebuild";
  /** 정착(SURFACE 전환) 시 접촉 중인 이웃 강체를 깨울지 (Rapier setBodyType wakeUp) */
  settleWakeUp: boolean;
  /** (예약) disable 모드 정리 정책. 현재는 활성 강체가 0 인 step 시작 시점에만 전부 제거한다. */
  purgeDelaySteps: number;
  purgePerStep: number;
  /** 원기둥 모서리 둥글림 반경 (units). 0 이면 일반 원기둥. 접촉 안정성에 크게 영향. */
  edgeRadius: number;
  /** 스폰 위치: 'axis' = 탑 축(원점) 위, 'top' = 현재 최고점 팬케이크 중심 위 */
  spawnMode: "axis" | "top";
  /**
   * 시럽 규칙: 고정 팬케이크(또는 바닥)에 닿았고 속도가 stickMaxSpeed 아래면 즉시 정착.
   * 미끄러짐을 막아 탑이 서게 하는 "세계 규칙" (플랜 §7).
   */
  stickOnContact: boolean;
  stickMaxSpeed: number;
  /** 정착 허용 침투 깊이 (두께 대비 비율) */
  stickMaxPenetration: number;
  /**
   * 드레이프(순응) 규칙: 정착 시 받침 팬케이크 면에 맞춰 눕힌다.
   * 0 = 강체 그대로(기울기 누적), 1 = 항상 완전히 평평. 0.5 = 받침 기울기의 절반만 물려받음.
   */
  drape: number;
  /** 정착 시 추가하는 무작위 기울기 (rad). 시각적 변화용. */
  settleTiltJitter: number;
  /** 솔버 반복 횟수 (Rapier 기본 4) */
  solverIterations: number;
  /** 접촉 소프트니스 고유진동수 (Hz, Rapier 기본 30). 낮으면 중력에 의해 파고든다. */
  contactHz: number;
  /** Collapse Day Release 시 각 팬케이크에 주는 무작위 수평 속도 (units/s). 0 이면 순수 중력만. */
  releaseKick: number;
  /** Rapier lengthUnit: 장면의 대표 객체 크기. 허용 오차/예측 거리의 기준. 0 이면 diameter 사용. */
  lengthUnit: number;
  ccd: boolean;
  /** CCD 서브스텝 (Rapier 기본 1) */
  ccdSubsteps: number;
  dt: number;
  seed: number;
  /** 배치가 이 step 수 안에 정착하지 않으면 강제 정착 */
  maxStepsPerBatch: number;
}

export const DEFAULT_CONFIG: SimConfig = {
  unitCm: 10,
  diameter: 1.0,
  thickness: 0.1,
  sizeJitter: 0.05,
  thicknessJitter: 0.1,
  gravity: -98.1,
  friction: 0.9,
  restitution: 0.0,
  angularDamping: 2.0,
  /** 공기저항. 종단속도 = |gravity| / linearDamping (2.0 → 49 u/s ≈ 4.9 m/s) */
  linearDamping: 2.0,
  density: 1.0,
  batchSize: 500,
  spawnPerStep: 2,
  spawnSpread: 0.2,
  spawnTilt: 0.15,
  spawnRecenter: 0.1,
  spawnClearance: 3,
  settleLinVel: 0.2,
  settleAngVel: 0.6,
  settleFrames: 10,
  freezeDepth: 0.6,
  freezeEnabled: true,
  settleWakeUp: false,
  // Phase 1: "remove"(Phase 0/0.5 방식) 는 배치 10~22장 패턴에서 Rapier 0.20 이 wasm 패닉(unreachable)을 냈다
  // (docs/phase1/CONTINUOUS_DROP.md). "rebuild" 는 개별 제거 API 를 쓰지 않고 활성 강체가 0 인 배치 경계에서 월드를
  // 다시 만들어 SURFACE 만 넣는다. 모든 패턴에서 크래시 없음, 속도 동일, 결과는 Phase 0.5 대비 0.02% 안쪽.
  freezeMode: "rebuild",
  purgeDelaySteps: 2,
  purgePerStep: 64,
  edgeRadius: 0.03,
  spawnMode: "top",
  stickOnContact: true,
  stickMaxSpeed: 1e9,
  stickMaxPenetration: 0.05,
  drape: 0.6,
  settleTiltJitter: 0.06,
  solverIterations: 4,
  contactHz: 30,
  releaseKick: 5.0,
  lengthUnit: 0,
  ccd: true,
  ccdSubsteps: 1,
  dt: 1 / 60,
  seed: 20260917,
  maxStepsPerBatch: 3000,
};

export type PancakeState = 0 | 1 | 2;
export const STATE_ACTIVE: PancakeState = 0;
export const STATE_SURFACE: PancakeState = 1;
export const STATE_FROZEN: PancakeState = 2;

export interface StepStats {
  step: number;
  stepMs: number;
  active: number;
  surface: number;
  frozen: number;
  spawned: number;
  settledThisStep: number;
  frozenThisStep: number;
  topY: number;
  leaks: number;
}

/**
 * Phase 0.5 Drape/변화 프리셋. Natural 이 DEFAULT_CONFIG 와 같다.
 * 동일 seed, 동일 개수로 비교한다 (benchmarks/phase0.5-*.md).
 */
export const PRESETS: Record<"stable" | "natural" | "loose", Partial<SimConfig>> = {
  stable: {
    drape: 0.9,
    settleTiltJitter: 0.02,
    spawnSpread: 0.1,
    spawnTilt: 0.05,
    spawnRecenter: 0.3,
    sizeJitter: 0.03,
    thicknessJitter: 0.05,
  },
  natural: {
    drape: 0.6,
    settleTiltJitter: 0.06,
    spawnSpread: 0.2,
    spawnTilt: 0.15,
    spawnRecenter: 0.1,
    sizeJitter: 0.05,
    thicknessJitter: 0.1,
  },
  loose: {
    drape: 0.35,
    settleTiltJitter: 0.12,
    spawnSpread: 0.35,
    spawnTilt: 0.3,
    spawnRecenter: 0.05,
    sizeJitter: 0.06,
    thicknessJitter: 0.12,
  },
};
export type PresetName = keyof typeof PRESETS;
