/**
 * 카메라 비행 계산 (순수 함수, 테스트 대상). Three.js 에 의존하지 않는다.
 */
export type Vec3 = [number, number, number];

export interface FlightPlan {
  fromPos: Vec3; fromTarget: Vec3;
  toPos: Vec3; toTarget: Vec3;
  durationMs: number;
}

export function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

const dist = (a: Vec3, b: Vec3): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/**
 * 이동 거리에 따른 비행 시간. 먼 거리는 로그 스케일로 늘려 수 km 도 3초 안팎.
 * reducedMotion 이면 0 (즉시).
 */
export function flightDuration(from: Vec3, to: Vec3, reducedMotion: boolean, base = 600, perLogUnit = 350, max = 3500): number {
  if (reducedMotion) return 0;
  const d = dist(from, to);
  return Math.min(max, base + perLogUnit * Math.log10(1 + d));
}

/** t ∈ [0,1] 에서의 카메라 위치/목표. t=1 이면 정확히 to 값. */
export function flightAt(plan: FlightPlan, t: number): { pos: Vec3; target: Vec3 } {
  if (t >= 1) return { pos: [...plan.toPos] as Vec3, target: [...plan.toTarget] as Vec3 };
  const e = easeInOutCubic(Math.max(0, t));
  const lerp = (a: Vec3, b: Vec3): Vec3 => [a[0] + (b[0] - a[0]) * e, a[1] + (b[1] - a[1]) * e, a[2] + (b[2] - a[2]) * e];
  // 먼 비행은 중간에 살짝 위로 떠서(포물선) 탑을 스치지 않게
  const pos = lerp(plan.fromPos, plan.toPos);
  const d = dist(plan.fromPos, plan.toPos);
  pos[1] += Math.sin(Math.PI * e) * Math.min(d * 0.15, 200);
  return { pos, target: lerp(plan.fromTarget, plan.toTarget) };
}

/** Find 대상 팬케이크를 보는 카메라 자리: 대상에서 비스듬히 위, 거리는 팬케이크 지름의 배수 */
export function findViewpoint(target: Vec3, diameter: number, yawRad = Math.PI / 4, distanceFactor = 3.5): { pos: Vec3; target: Vec3 } {
  const d = diameter * distanceFactor;
  return { target: [...target] as Vec3, pos: [target[0] + Math.cos(yawRad) * d, target[1] + d * 0.45, target[2] + Math.sin(yawRad) * d] };
}

/** 탑 전체가 세로로 화면에 들어오는 카메라 자리 (FOV 로 계산) */
export function fullTowerViewpoint(heightUnits: number, fovYRad: number, aspect: number, margin = 1.15): { pos: Vec3; target: Vec3 } {
  const h = Math.max(heightUnits, 1);
  const halfH = (h / 2) * margin;
  const distV = halfH / Math.tan(fovYRad / 2);
  const fovX = 2 * Math.atan(Math.tan(fovYRad / 2) * aspect);
  const distH = (0.5 * margin) / Math.tan(fovX / 2);
  const d = Math.max(distV, distH, 3);
  return { target: [0, h / 2, 0], pos: [d * 0.7071, h / 2 + d * 0.2, d * 0.7071] };
}

/** 탑 꼭대기 근접 뷰 */
export function topViewpoint(heightUnits: number, diameter: number): { pos: Vec3; target: Vec3 } {
  const d = diameter * 4;
  return { target: [0, heightUnits, 0], pos: [d * 0.7, heightUnits + d * 0.5, d * 0.7] };
}

/** 특정 고도로 이동 (altitude navigator): 탑 축 옆에서 그 높이를 본다 */
export function altitudeViewpoint(altitudeUnits: number, heightUnits: number, diameter: number): { pos: Vec3; target: Vec3 } {
  const y = Math.min(Math.max(0, altitudeUnits), heightUnits + diameter * 2);
  const d = diameter * 6;
  return { target: [0, y, 0], pos: [d * 0.7, y + d * 0.25, d * 0.7] };
}
