/**
 * screen-space 크기 (Phase 1 §7). LOD 와 chunk 상태는 world 거리가 아니라 투영된 팬케이크 직경(px)으로 정한다.
 */
export interface Viewport {
  /** 수직 FOV (rad) */
  fovY: number;
  heightPx: number;
  /** devicePixelRatio 를 곱하려면 호출자가 heightPx 에 반영 */
}

/** 거리 d 에서 지름 diameter 인 물체의 화면 투영 크기 (px) */
export function projectedDiameterPx(distance: number, diameter: number, vp: Viewport): number {
  if (distance <= 0) return Infinity;
  return diameter * (vp.heightPx / (2 * distance * Math.tan(vp.fovY / 2)));
}

/** 투영 크기(px) 가 diameter 인 물체에 대해 px 가 되는 거리 */
export function distanceForProjectedPx(px: number, diameter: number, vp: Viewport): number {
  return diameter * (vp.heightPx / (2 * px * Math.tan(vp.fovY / 2)));
}

/** AABB 에서 점까지의 최소 거리 */
export function distanceToBounds(p: [number, number, number], b: { min: [number, number, number]; max: [number, number, number] }): number {
  let d2 = 0;
  for (let i = 0; i < 3; i++) {
    const v = p[i];
    if (v < b.min[i]) d2 += (b.min[i] - v) ** 2;
    else if (v > b.max[i]) d2 += (v - b.max[i]) ** 2;
  }
  return Math.sqrt(d2);
}

/** AABB 에서 점까지의 최대 거리 (가장 먼 꼭짓점) */
export function maxDistanceToBounds(p: [number, number, number], b: { min: [number, number, number]; max: [number, number, number] }): number {
  let d2 = 0;
  for (let i = 0; i < 3; i++) d2 += Math.max(Math.abs(p[i] - b.min[i]), Math.abs(p[i] - b.max[i])) ** 2;
  return Math.sqrt(d2);
}
