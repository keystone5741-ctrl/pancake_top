import type { Bounds3 } from "./chunk";

/** 평면 n·p + d ≥ 0 이면 안쪽. Three.js Frustum.planes 와 같은 규약. */
export interface Plane {
  normal: [number, number, number];
  constant: number;
}
export type FrustumPlanes = Plane[];

/** AABB 가 절두체와 교차/포함되는가 (보수적: 완전히 바깥일 때만 false) */
export function boundsIntersectsFrustum(b: Bounds3, planes: FrustumPlanes): boolean {
  for (const pl of planes) {
    const n = pl.normal;
    // 평면 법선 방향의 가장 먼 꼭짓점(p-vertex)
    const px = n[0] > 0 ? b.max[0] : b.min[0];
    const py = n[1] > 0 ? b.max[1] : b.min[1];
    const pz = n[2] > 0 ? b.max[2] : b.min[2];
    if (n[0] * px + n[1] * py + n[2] * pz + pl.constant < 0) return false;
  }
  return true;
}
