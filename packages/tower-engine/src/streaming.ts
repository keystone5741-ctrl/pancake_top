import type { ChunkId } from "pancake-core";
import type { ChunkHeader, ChunkState } from "./chunk";
import { distanceToBounds, projectedDiameterPx, type Viewport } from "./projection";
import { boundsIntersectsFrustum, type FrustumPlanes } from "./visibility";

/** 상태 전환 기준 (Phase 1 §5, §7). 값은 설정이며 실기기 측정 후 조정. */
export interface StreamingPolicy {
  /** 투영 직경이 이 값(px) 이상이면 GPU_HIGH (고품질 LOD 포함) */
  highLodMinPx: number;
  /** 절두체 밖 chunk 도 이 배수 안쪽 거리면 CPU_READY 로 미리 둔다 (prefetch) */
  prefetchDistanceFactor: number;
  /** 카메라에서 이 거리(units) 안쪽의 chunk 는 절두체 밖이어도 GPU_LOW 유지 (회전 시 팝인 방지) */
  keepGpuDistance: number;
  /**
   * 절두체 안이라도 가장 가까운 점의 투영 직경이 이 값(px) 미만이면 받지 않는다 (UNLOADED).
   * 서브픽셀 chunk 는 실루엣 보조(Far View B)가 대신 그린다. 0 이면 보이는 chunk 를 전부 받는다 (Phase 1 동작).
   * Phase 2 §46: 1M 서버 월드 Top 뷰에서 94/100 chunk(36 MB)를 받던 것을 이 기준으로 줄인다.
   */
  minVisiblePx: number;
}

export const DEFAULT_STREAMING_POLICY: StreamingPolicy = {
  highLodMinPx: 4,
  prefetchDistanceFactor: 2,
  keepGpuDistance: 200,
  minVisiblePx: 0.5,
};

export interface CameraInfo {
  position: [number, number, number];
  frustum: FrustumPlanes;
  viewport: Viewport;
}

export interface ChunkDecision {
  id: ChunkId;
  desired: ChunkState;
  /** chunk 에서 가장 가까운 점의 투영 직경 (px) */
  projectedPx: number;
  visible: boolean;
  distance: number;
}

/** 카메라 기준으로 각 chunk 의 목표 상태를 정한다. 순수 함수. */
export function decideChunkStates(headers: readonly ChunkHeader[], cam: CameraInfo, diameter: number, policy: StreamingPolicy = DEFAULT_STREAMING_POLICY): ChunkDecision[] {
  const out: ChunkDecision[] = [];
  for (const h of headers) {
    const visible = boundsIntersectsFrustum(h.bounds, cam.frustum);
    const distance = distanceToBounds(cam.position, h.bounds);
    const projectedPx = projectedDiameterPx(Math.max(distance, 1e-6), diameter, cam.viewport);
    let desired: ChunkState;
    const subPixel = projectedPx < policy.minVisiblePx;
    if (visible && !subPixel) desired = projectedPx >= policy.highLodMinPx ? "GPU_HIGH" : "GPU_LOW";
    else if (distance <= policy.keepGpuDistance) desired = "GPU_LOW";
    else if (distance <= policy.keepGpuDistance * policy.prefetchDistanceFactor) desired = "CPU_READY";
    else desired = "UNLOADED";
    out.push({ id: h.id, desired, projectedPx, visible, distance });
  }
  return out;
}
