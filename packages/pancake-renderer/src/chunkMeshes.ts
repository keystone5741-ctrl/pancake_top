import * as THREE from "three";
import { TRANSFORM_STRIDE, projectedDiameterPx, type TowerChunk, type Viewport } from "tower-engine";
import type { LodGeometries } from "./geometry";
import { lodForProjectedPx, type LodThresholdsPx } from "./quality";

const _m = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _c = new THREE.Color();

/**
 * 한 chunk 의 GPU 표현: LOD 별 InstancedMesh 3개. 같은 팬케이크가 카메라 거리에 따라 다른 mesh 로 옮겨 그려질 뿐,
 * 어떤 LOD 에서도 팬케이크 하나 = 인스턴스 하나다 (Phase 1 §0, §6).
 */
export class ChunkMeshSet {
  readonly group = new THREE.Group();
  readonly meshes: [THREE.InstancedMesh, THREE.InstancedMesh, THREE.InstancedMesh];
  /** 현재 LOD 별 인스턴스 수 */
  counts: [number, number, number] = [0, 0, 0];
  /** instance index (LOD, slot) ← pancake instanceIndex 매핑 (하이라이트/조회용) */
  private slotOf: Int32Array;
  private lodOf: Uint8Array;
  private readonly baseColors: Float32Array;
  private lowOnly = false;

  constructor(readonly chunk: TowerChunk, geometries: LodGeometries, material: THREE.Material, colors: Float32Array, shadows: boolean) {
    this.baseColors = colors;
    this.meshes = [0, 1, 2].map((lod) => {
      const m = new THREE.InstancedMesh(geometries.lod[lod], material, chunk.count);
      m.count = 0;
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.frustumCulled = false; // chunk 단위 컬링은 ChunkRenderer 가 bounds 로 수행
      m.castShadow = shadows; m.receiveShadow = shadows;
      m.name = `chunk-${chunk.id}-lod${lod}`;
      this.group.add(m);
      return m;
    }) as [THREE.InstancedMesh, THREE.InstancedMesh, THREE.InstancedMesh];
    this.slotOf = new Int32Array(chunk.count).fill(-1);
    this.lodOf = new Uint8Array(chunk.count).fill(2);
    const b = chunk.bounds;
    this.group.userData.bounds = b;
  }

  get renderedInstances(): number { return this.counts[0] + this.counts[1] + this.counts[2]; }

  /** 모든 인스턴스를 far LOD 로 (GPU_LOW) */
  fillLowOnly(): void {
    if (this.lowOnly && this.counts[2] === this.chunk.count) return;
    this.lowOnly = true;
    this.assign((_i) => 2, Infinity);
  }

  /** 카메라 거리로 인스턴스마다 LOD 를 정한다 (GPU_HIGH). maxHigh 를 넘는 LOD0 는 LOD1 로 내린다. */
  partitionByCamera(camPos: THREE.Vector3, vp: Viewport, thresholds: LodThresholdsPx, diameter: number, maxHigh: number): void {
    this.lowOnly = false;
    const t = this.chunk.transforms;
    this.assign((i) => {
      const o = i * TRANSFORM_STRIDE;
      const d = Math.hypot(t[o] - camPos.x, t[o + 1] - camPos.y, t[o + 2] - camPos.z);
      return lodForProjectedPx(projectedDiameterPx(d, diameter * t[o + 7], vp), thresholds);
    }, maxHigh);
  }

  private assign(pick: (i: number) => 0 | 1 | 2, maxHigh: number): void {
    const n = this.chunk.count;
    const t = this.chunk.transforms;
    const counts: [number, number, number] = [0, 0, 0];
    for (let i = 0; i < n; i++) {
      let lod = pick(i);
      if (lod === 0 && counts[0] >= maxHigh) lod = 1;
      const o = i * TRANSFORM_STRIDE;
      _p.set(t[o], t[o + 1], t[o + 2]);
      _q.set(t[o + 3], t[o + 4], t[o + 5], t[o + 6]);
      _s.set(t[o + 7], t[o + 8], t[o + 7]);
      _m.compose(_p, _q, _s);
      const slot = counts[lod]++;
      const mesh = this.meshes[lod];
      mesh.setMatrixAt(slot, _m);
      _c.setRGB(this.baseColors[i * 3], this.baseColors[i * 3 + 1], this.baseColors[i * 3 + 2]);
      mesh.setColorAt(slot, _c);
      this.slotOf[i] = slot;
      this.lodOf[i] = lod;
    }
    for (let lod = 0; lod < 3; lod++) {
      const mesh = this.meshes[lod];
      mesh.count = counts[lod];
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
    this.counts = counts;
  }

  /** 인스턴스의 현재 렌더 행렬 (수렴 검증/디버그) */
  readMatrix(instanceIndex: number, out: THREE.Matrix4): boolean {
    const slot = this.slotOf[instanceIndex];
    if (slot < 0) return false;
    this.meshes[this.lodOf[instanceIndex]].getMatrixAt(slot, out);
    return true;
  }

  /** transform 배열이 바뀐 인스턴스들만 다시 쓴다 (Drop replay 용). LOD 배치는 유지. */
  refreshInstances(indices: Iterable<number>): void {
    const t = this.chunk.transforms;
    const touched = new Set<number>();
    for (const i of indices) {
      const slot = this.slotOf[i];
      if (slot < 0) continue;
      const o = i * TRANSFORM_STRIDE;
      _p.set(t[o], t[o + 1], t[o + 2]);
      _q.set(t[o + 3], t[o + 4], t[o + 5], t[o + 6]);
      _s.set(t[o + 7], t[o + 8], t[o + 7]);
      _m.compose(_p, _q, _s);
      this.meshes[this.lodOf[i]].setMatrixAt(slot, _m);
      touched.add(this.lodOf[i]);
    }
    for (const lod of touched) this.meshes[lod].instanceMatrix.needsUpdate = true;
  }

  setVisible(v: boolean): void { this.group.visible = v; }

  dispose(): void {
    for (const m of this.meshes) m.dispose();
    this.group.removeFromParent();
  }
}
