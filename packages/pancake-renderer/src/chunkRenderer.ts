import * as THREE from "three";
import { decideChunkStates, distanceToBounds, projectedDiameterPx, estimateInstanceBytes, type Tower, type Viewport, type FindResult, type StreamingPolicy, DEFAULT_STREAMING_POLICY, type ChunkDecision } from "tower-engine";
import type { ChunkId as CoreChunkId } from "pancake-core";
import { ChunkMeshSet } from "./chunkMeshes";
import { chunkBaseColors } from "./colors";
import { makeLodGeometries, type LodGeometries } from "./geometry";
import { HighlightMarker } from "./highlight";
import { QualityManager, type RenderQuality } from "./quality";
import { SilhouetteAssist } from "./silhouette";

export interface ChunkRendererOptions {
  streaming?: StreamingPolicy;
  /** 이 거리(units) 이상 카메라가 움직이면 GPU_HIGH chunk 의 LOD 를 다시 나눈다 */
  repartitionDistance?: number;
}

/**
 * Chunked Tower Renderer (플랜 §5, Phase 1 §3~§10).
 * Tower(엔진) 의 chunk 상태를 카메라에 따라 전환하고, chunk 마다 LOD 별 InstancedMesh 를 유지한다.
 */
export class ChunkRenderer {
  readonly group = new THREE.Group();
  readonly highlight: HighlightMarker;
  readonly silhouette = new SilhouetteAssist();
  private geometries: LodGeometries;
  private readonly material: THREE.MeshStandardMaterial;
  private readonly meshSets = new Map<CoreChunkId, ChunkMeshSet>();
  private readonly colorCache = new Map<CoreChunkId, Float32Array>();
  readonly policy: StreamingPolicy;
  private readonly repartitionDistance: number;
  private lastPartitionPos = new THREE.Vector3(Infinity, Infinity, Infinity);
  private lastQualityName: string;
  private frustum = new THREE.Frustum();
  private projScreen = new THREE.Matrix4();
  lastDecisions: ChunkDecision[] = [];
  /** 마지막 update 의 통계 */
  stats = { renderedInstances: 0, lodCounts: [0, 0, 0] as [number, number, number], gpuChunks: 0, visibleChunks: 0, projectedPxAtNearest: 0, estimatedGpuInstanceBytes: 0 };

  constructor(readonly tower: Tower, readonly quality: QualityManager, opts: ChunkRendererOptions = {}) {
    this.policy = opts.streaming ?? DEFAULT_STREAMING_POLICY;
    this.repartitionDistance = opts.repartitionDistance ?? 1.0;
    const q = quality.current;
    this.geometries = makeLodGeometries(tower.config.diameter, tower.config.thickness, q);
    this.material = new THREE.MeshStandardMaterial({ roughness: 0.75, metalness: 0 });
    this.highlight = new HighlightMarker(tower.config.diameter, tower.config.thickness, this.geometries.lod[0]);
    this.group.add(this.highlight.group, this.silhouette.group);
    this.lastQualityName = q.name;
    quality.onChange((nq) => this.applyQuality(nq));
  }

  get lodTriangles(): [number, number, number] { return this.geometries.triangles; }

  private applyQuality(q: RenderQuality): void {
    if (q.name === this.lastQualityName) return;
    this.lastQualityName = q.name;
    // 지오메트리 교체: 모든 mesh set 재생성
    for (const [id, set] of this.meshSets) { set.dispose(); this.meshSets.delete(id); this.tower.setState(id, "CPU_READY"); }
    this.geometries.dispose();
    this.geometries = makeLodGeometries(this.tower.config.diameter, this.tower.config.thickness, q);
    this.lastPartitionPos.set(Infinity, Infinity, Infinity);
    this.silhouette.mode = q.silhouetteAssist ? this.silhouette.mode : "pure";
  }

  private ensureMeshSet(id: CoreChunkId): ChunkMeshSet | undefined {
    let set = this.meshSets.get(id);
    if (set) return set;
    const chunk = this.tower.chunk(id) ?? this.tower.loadChunkSync(id);
    if (!chunk) return undefined;
    let colors = this.colorCache.get(id);
    if (!colors) { colors = chunkBaseColors(chunk); this.colorCache.set(id, colors); }
    set = new ChunkMeshSet(chunk, this.geometries, this.material, colors, this.quality.current.shadowMode === "sun");
    this.meshSets.set(id, set);
    this.group.add(set.group);
    return set;
  }

  /** chunk 를 고품질로 강제 (Find 흐름: chunk activate → LOD load) */
  async ensureChunkHigh(id: CoreChunkId): Promise<void> {
    await this.tower.loadChunk(id);
    const set = this.ensureMeshSet(id);
    if (set) { this.tower.setState(id, "GPU_HIGH"); this.lastPartitionPos.set(Infinity, Infinity, Infinity); }
  }

  /** 매 프레임: 카메라 기준으로 chunk 상태·가시성·LOD 를 갱신 */
  private decide(camera: THREE.PerspectiveCamera, vp: Viewport): ChunkDecision[] {
    camera.updateMatrixWorld();
    this.projScreen.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.projScreen);
    const planes = this.frustum.planes.map((p) => ({ normal: [p.normal.x, p.normal.y, p.normal.z] as [number, number, number], constant: p.constant }));
    const pos = new THREE.Vector3().setFromMatrixPosition(camera.matrixWorld);
    return decideChunkStates(this.tower.headers, { position: [pos.x, pos.y, pos.z], frustum: planes, viewport: vp }, this.tower.config.diameter, this.policy);
  }

  /** 네트워크에서 받은 chunk 수 (예측 스트리밍 진단) */
  fetchStats = { requested: 0, skippedInFlight: 0 };

  /**
   * @param fetchCamera 비행 중이면 도착 지점 카메라. 있으면 새 chunk 는 도착 지점에서 필요한 것만 받는다 (Phase 2 §46:
   *   탑을 따라 내려가는 비행이 지나치는 chunk 를 전부 받지 않게). 이미 받은 chunk 는 현재 카메라 기준으로 그린다.
   */
  update(camera: THREE.PerspectiveCamera, viewportHeightPx: number, dtMs = 16, fetchCamera?: THREE.PerspectiveCamera): void {
    const vp: Viewport = { fovY: (camera.fov * Math.PI) / 180, heightPx: viewportHeightPx };
    const q = this.quality.current;
    const decisions = this.decide(camera, vp);
    camera.updateMatrixWorld();
    const camPos = new THREE.Vector3().setFromMatrixPosition(camera.matrixWorld);
    const fetchOk = new Set<number>();
    if (fetchCamera) for (const d of this.decide(fetchCamera, vp)) if (d.desired !== "UNLOADED") fetchOk.add(d.id);
    const mayFetch = (id: number): boolean => { if (!fetchCamera || fetchOk.has(id)) { this.fetchStats.requested++; return true; } this.fetchStats.skippedInFlight++; return false; };
    this.lastDecisions = decisions;
    const moved = camPos.distanceTo(this.lastPartitionPos) > this.repartitionDistance;
    let rendered = 0, gpuChunks = 0, visibleChunks = 0;
    const lodCounts: [number, number, number] = [0, 0, 0];
    let nearestPx = 0;

    for (const d of decisions) {
      const cur = this.tower.state(d.id);
      if (d.projectedPx > nearestPx) nearestPx = d.projectedPx;
      if (d.desired === "UNLOADED") {
        if (cur !== "UNLOADED") { this.meshSets.get(d.id)?.dispose(); this.meshSets.delete(d.id); this.tower.unloadChunk(d.id); }
        continue;
      }
      if (d.desired === "CPU_READY") {
        if (cur === "GPU_LOW" || cur === "GPU_HIGH") { this.meshSets.get(d.id)?.dispose(); this.meshSets.delete(d.id); this.tower.setState(d.id, "CPU_READY"); }
        else if (cur === "UNLOADED") { if (!this.tower.loadChunkSync(d.id) && mayFetch(d.id)) void this.tower.loadChunk(d.id); }
        continue;
      }
      // GPU_LOW / GPU_HIGH
      const set = this.ensureMeshSet(d.id);
      if (!set) { if (mayFetch(d.id)) void this.tower.loadChunk(d.id); continue; }
      if (d.desired === "GPU_LOW") {
        if (cur !== "GPU_LOW") { set.fillLowOnly(); this.tower.setState(d.id, "GPU_LOW"); }
      } else {
        if (cur !== "GPU_HIGH" || moved) {
          set.partitionByCamera(camPos, vp, q.lodThresholdsPx, this.tower.config.diameter, q.maxHighLodInstances);
          this.tower.setState(d.id, "GPU_HIGH");
        }
      }
      set.setVisible(d.visible);
      gpuChunks++;
      if (d.visible) {
        visibleChunks++;
        rendered += set.renderedInstances;
        lodCounts[0] += set.counts[0]; lodCounts[1] += set.counts[1]; lodCounts[2] += set.counts[2];
      }
    }
    if (moved) this.lastPartitionPos.copy(camPos);

    let gpuBytes = 0;
    for (const set of this.meshSets.values()) gpuBytes += estimateInstanceBytes(set.chunk.count, 3);
    this.stats = { renderedInstances: rendered, lodCounts, gpuChunks, visibleChunks, projectedPxAtNearest: nearestPx, estimatedGpuInstanceBytes: gpuBytes };
    this.quality.updateMetrics({ renderedInstances: rendered, lodCounts, gpuChunks, loadedChunks: this.tower.loadedChunkCount, estimatedGpuInstanceBytes: gpuBytes });

    // 실루엣: 카메라에서 탑 축까지의 거리로 본 팬케이크 투영 크기로 fade
    const axisDist = Math.max(1e-3, distanceToBounds([camPos.x, camPos.y, camPos.z], { min: [-0.5, 0, -0.5], max: [0.5, this.tower.height, 0.5] }));
    this.silhouette.update(this.tower.height, camera, projectedDiameterPx(axisDist, this.tower.config.diameter, vp));
    this.highlight.update(dtMs);
  }

  /** chunk 내용이 바뀌었을 때 (append 등) GPU 표현을 버린다. 다음 update 에서 다시 만든다. */
  invalidateChunks(ids: Iterable<import("pancake-core").ChunkId>): void {
    for (const id of ids) { this.meshSets.get(id)?.dispose(); this.meshSets.delete(id); this.colorCache.delete(id); }
    this.lastPartitionPos.set(Infinity, Infinity, Infinity);
  }

  /** 팬케이크 선택 강조 */
  select(r: FindResult | null): void { if (r) this.highlight.select(r); else this.highlight.clear(); }

  /** chunk 의 transform 배열이 바뀐 인스턴스를 GPU 에 반영 (replay) */
  refreshInstances(chunkId: CoreChunkId, indices: Iterable<number>): void { this.meshSets.get(chunkId)?.refreshInstances(indices); }

  /** 인스턴스의 현재 렌더 행렬 */
  readInstanceMatrix(chunkId: CoreChunkId, instanceIndex: number, out: THREE.Matrix4): boolean {
    return this.meshSets.get(chunkId)?.readMatrix(instanceIndex, out) ?? false;
  }

  dispose(): void {
    for (const set of this.meshSets.values()) set.dispose();
    this.meshSets.clear();
    this.geometries.dispose();
    this.material.dispose();
  }
}
