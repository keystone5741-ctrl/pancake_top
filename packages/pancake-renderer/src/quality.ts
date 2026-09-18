/**
 * Quality Manager (Phase 1 §30, §31). 품질 관련 값은 여기 한 곳에만 있다.
 * Phase 0.75 실제 기기 결과가 들어오면 preset 값과 recommendPreset 의 threshold 만 바꾼다.
 */
export type QualityPresetName = "performance" | "standard" | "ultra";

export interface LodThresholdsPx {
  /** 투영 직경이 이 값(px) 이상이면 LOD0 */
  lod0: number;
  /** 이 값 이상이면 LOD1, 아래면 LOD2 */
  lod1: number;
}

export interface RenderQuality {
  name: QualityPresetName;
  /** 둘레 분할 수 */
  closeGeometry: { segments: number; roundedEdge: boolean };
  mediumGeometry: { segments: number; roundedEdge: boolean };
  farGeometry: { segments: number; roundedEdge: boolean };
  shadowMode: "none" | "sun";
  /** GPU_HIGH chunk 에서 LOD0 로 그릴 수 있는 최대 인스턴스 수 (초과분은 LOD1 로) */
  maxHighLodInstances: number;
  lodThresholdsPx: LodThresholdsPx;
  silhouetteAssist: boolean;
  pixelRatioCap: number;
  antialias: boolean;
}

export const QUALITY_PRESETS: Record<QualityPresetName, RenderQuality> = {
  performance: {
    name: "performance",
    closeGeometry: { segments: 16, roundedEdge: false },
    mediumGeometry: { segments: 8, roundedEdge: false },
    farGeometry: { segments: 6, roundedEdge: false },
    shadowMode: "none",
    maxHighLodInstances: 5_000,
    lodThresholdsPx: { lod0: 40, lod1: 6 },
    silhouetteAssist: true,
    pixelRatioCap: 1.5,
    antialias: false,
  },
  standard: {
    name: "standard",
    closeGeometry: { segments: 32, roundedEdge: true },
    mediumGeometry: { segments: 10, roundedEdge: false },
    farGeometry: { segments: 6, roundedEdge: false },
    shadowMode: "none",
    maxHighLodInstances: 20_000,
    lodThresholdsPx: { lod0: 20, lod1: 4 },
    silhouetteAssist: true,
    pixelRatioCap: 2,
    antialias: true,
  },
  ultra: {
    name: "ultra",
    closeGeometry: { segments: 48, roundedEdge: true },
    mediumGeometry: { segments: 16, roundedEdge: true },
    farGeometry: { segments: 8, roundedEdge: false },
    shadowMode: "sun",
    maxHighLodInstances: 60_000,
    lodThresholdsPx: { lod0: 12, lod1: 3 },
    silhouetteAssist: true,
    pixelRatioCap: 2,
    antialias: true,
  },
};

export interface QualityMetrics {
  fps: number;
  frameMsP95: number;
  drawCalls: number;
  renderedInstances: number;
  lodCounts: [number, number, number];
  loadedChunks: number;
  gpuChunks: number;
  estimatedGpuInstanceBytes: number;
}

export interface DeviceHints {
  gpuRenderer?: string;
  deviceMemoryGB?: number | null;
  hardwareConcurrency?: number | null;
  mobile?: boolean;
  /** 실측 p95 frame time (ms). 있으면 우선 */
  measuredP95Ms?: number;
}

/** 투영 직경(px)으로 LOD 결정. 순수 함수 (테스트 대상). */
export function lodForProjectedPx(px: number, t: LodThresholdsPx): 0 | 1 | 2 {
  if (px >= t.lod0) return 0;
  if (px >= t.lod1) return 1;
  return 2;
}

/**
 * 단순 휴리스틱 추천 (Phase 1 §31). 실측이 있으면 실측 우선.
 *  - p95 < 20 ms → ultra 가능, < 33 ms → standard, 그 외 performance
 *  - 실측이 없으면 모바일 = performance, 데스크톱 = standard (ultra 는 실측 후에만)
 */
export function recommendPreset(h: DeviceHints): QualityPresetName {
  if (typeof h.measuredP95Ms === "number") {
    if (h.measuredP95Ms < 20 && !h.mobile) return "ultra";
    if (h.measuredP95Ms < 33) return "standard";
    return "performance";
  }
  if (h.mobile) return "performance";
  if (/SwiftShader|llvmpipe|Software/i.test(h.gpuRenderer ?? "")) return "performance";
  return "standard";
}

export class QualityManager {
  private preset: RenderQuality;
  private metrics: QualityMetrics = { fps: 0, frameMsP95: 0, drawCalls: 0, renderedInstances: 0, lodCounts: [0, 0, 0], loadedChunks: 0, gpuChunks: 0, estimatedGpuInstanceBytes: 0 };
  private readonly listeners = new Set<(q: RenderQuality) => void>();

  constructor(name: QualityPresetName = "standard") { this.preset = QUALITY_PRESETS[name]; }
  get current(): RenderQuality { return this.preset; }
  setPreset(name: QualityPresetName): void {
    if (this.preset.name === name) return;
    this.preset = QUALITY_PRESETS[name];
    for (const l of this.listeners) l(this.preset);
  }
  onChange(l: (q: RenderQuality) => void): () => void { this.listeners.add(l); return () => this.listeners.delete(l); }
  updateMetrics(m: Partial<QualityMetrics>): void { Object.assign(this.metrics, m); }
  getMetrics(): QualityMetrics { return { ...this.metrics, lodCounts: [...this.metrics.lodCounts] as [number, number, number] }; }
  recommendPreset(hints: DeviceHints = {}): QualityPresetName {
    return recommendPreset({ measuredP95Ms: this.metrics.frameMsP95 > 0 ? this.metrics.frameMsP95 : undefined, ...hints });
  }
}
