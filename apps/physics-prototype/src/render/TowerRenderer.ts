import * as THREE from "three";
import { STATE_ACTIVE, STATE_FROZEN } from "../sim";

/**
 * 렌더러가 읽는 것 = 서버가 결정한 값뿐 (플랜 §8, Phase 0.5 §7).
 * TowerSim(라이브 물리) 과 로드된 TowerData(서버 결과 파일) 둘 다 이 형태를 만족한다.
 */
export interface InstanceSource {
  px: Float32Array; py: Float32Array; pz: Float32Array;
  qx: Float32Array; qy: Float32Array; qz: Float32Array; qw: Float32Array;
  scale: Float32Array; tscale: Float32Array;
  state: Uint8Array;
  spawned: number;
  dirty: number[];
}

export type Quality = "ultra" | "standard" | "performance";

export interface RenderOptions {
  chunkSize: number;
  diameter: number;
  thickness: number;
  quality: Quality;
  colorByState: boolean;
}

const QUALITY = {
  ultra: { segments: 32, shadows: true },
  standard: { segments: 16, shadows: false },
  performance: { segments: 8, shadows: false },
} as const;

/**
 * 플랜 §4 / §5: 팬케이크 = 독립 Instance, Chunk 단위 InstancedMesh.
 * Chunk 당 하나의 draw call. 카메라 컬링은 Three.js frustum culling 이 Chunk bounding sphere 로 수행.
 */
export class TowerRenderer {
  readonly group = new THREE.Group();
  private chunks: THREE.InstancedMesh[] = [];
  private readonly geometry: THREE.BufferGeometry;
  private readonly material: THREE.MeshStandardMaterial;
  private readonly opts: RenderOptions;
  private readonly capacity: number;
  private readonly m = new THREE.Matrix4();
  private readonly p = new THREE.Vector3();
  private readonly q = new THREE.Quaternion();
  private readonly s = new THREE.Vector3();
  private readonly c = new THREE.Color();
  private readonly baseColors: Float32Array;

  constructor(scene: THREE.Scene, capacity: number, opts: RenderOptions) {
    this.opts = opts;
    this.capacity = capacity;
    const seg = QUALITY[opts.quality].segments;
    this.geometry = makePancakeGeometry(opts.diameter / 2, opts.thickness, seg);
    this.material = new THREE.MeshStandardMaterial({ roughness: 0.75, metalness: 0.0 });
    this.baseColors = new Float32Array(capacity * 3);
    const base = new THREE.Color("#d9a15c");
    const hsl = { h: 0, s: 0, l: 0 };
    base.getHSL(hsl);
    for (let i = 0; i < capacity; i++) {
      // 굽기/색상 편차 (플랜 §4)
      const r = hash(i);
      this.c.setHSL(hsl.h + (r - 0.5) * 0.02, hsl.s + (hash(i + 1) - 0.5) * 0.15, hsl.l + (hash(i + 2) - 0.5) * 0.18);
      this.baseColors[i * 3] = this.c.r;
      this.baseColors[i * 3 + 1] = this.c.g;
      this.baseColors[i * 3 + 2] = this.c.b;
    }
    scene.add(this.group);
  }

  get drawGroups(): number {
    return this.chunks.filter((ch) => ch.count > 0).length;
  }

  get shadows(): boolean {
    return QUALITY[this.opts.quality].shadows;
  }

  private chunkFor(id: number): THREE.InstancedMesh {
    const ci = Math.floor(id / this.opts.chunkSize);
    while (this.chunks.length <= ci) {
      const n = Math.min(this.opts.chunkSize, this.capacity - this.chunks.length * this.opts.chunkSize);
      const mesh = new THREE.InstancedMesh(this.geometry, this.material, Math.max(1, n));
      mesh.count = 0;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.castShadow = this.shadows;
      mesh.receiveShadow = this.shadows;
      mesh.frustumCulled = false; // bounding sphere 가 매 프레임 바뀌므로 Phase 0 에서는 컬링 생략
      this.group.add(mesh);
      this.chunks.push(mesh);
    }
    return this.chunks[ci];
  }

  /** sim.dirty 에 있는 id 들의 행렬/색을 갱신 */
  sync(sim: InstanceSource): void {
    const touched = new Set<THREE.InstancedMesh>();
    const cs = this.opts.chunkSize;
    for (const id of sim.dirty) {
      const mesh = this.chunkFor(id);
      const idx = id % cs;
      this.p.set(sim.px[id], sim.py[id], sim.pz[id]);
      this.q.set(sim.qx[id], sim.qy[id], sim.qz[id], sim.qw[id]);
      const sc = sim.scale[id];
      this.s.set(sc, sim.tscale[id], sc);
      this.m.compose(this.p, this.q, this.s);
      mesh.setMatrixAt(idx, this.m);
      if (idx >= mesh.count) mesh.count = idx + 1;

      const st = sim.state[id];
      const br = this.baseColors[id * 3], bg = this.baseColors[id * 3 + 1], bb = this.baseColors[id * 3 + 2];
      if (id === this.highlighted) this.c.setRGB(1.0, 0.2, 0.2);
      else if (this.opts.colorByState && st === STATE_ACTIVE) this.c.setRGB(1.0, 0.95, 0.75);
      else if (this.opts.colorByState && st === STATE_FROZEN) this.c.setRGB(br * 0.75, bg * 0.75, bb * 0.75);
      else this.c.setRGB(br, bg, bb);
      mesh.setColorAt(idx, this.c);
      touched.add(mesh);
    }
    for (const mesh of touched) {
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
  }

  private highlighted = -1;

  /**
   * Find My Pancake (플랜 §35): id → chunk → instance index. 전체 탐색 없이 O(1).
   * 반환: 월드 좌표. 없으면 null.
   */
  locate(id: number): THREE.Vector3 | null {
    const ci = Math.floor(id / this.opts.chunkSize);
    const mesh = this.chunks[ci];
    if (!mesh || id % this.opts.chunkSize >= mesh.count) return null;
    mesh.getMatrixAt(id % this.opts.chunkSize, this.m);
    return new THREE.Vector3().setFromMatrixPosition(this.m);
  }

  /** 강조 표시 (이전 강조는 해제). 색만 바꾸며 transform 은 건드리지 않는다. */
  highlight(id: number, src: InstanceSource): void {
    const prev = this.highlighted;
    this.highlighted = id;
    const saved = src.dirty;
    src.dirty = prev >= 0 ? [prev, id] : [id];
    this.sync(src);
    src.dirty = saved;
  }

  /** 인스턴스 하나의 현재 행렬 위치/회전을 읽는다 (수렴 검증용) */
  readInstance(id: number, outPos: THREE.Vector3, outQuat: THREE.Quaternion): boolean {
    const ci = Math.floor(id / this.opts.chunkSize);
    const mesh = this.chunks[ci];
    if (!mesh) return false;
    mesh.getMatrixAt(id % this.opts.chunkSize, this.m);
    this.m.decompose(outPos, outQuat, this.s);
    return true;
  }

  /** 전체 재동기화 (품질 변경 등) */
  syncAll(sim: InstanceSource): void {
    const saved = sim.dirty;
    sim.dirty = Array.from({ length: sim.spawned }, (_, i) => i);
    this.sync(sim);
    sim.dirty = saved;
  }

  dispose(scene: THREE.Scene): void {
    for (const ch of this.chunks) ch.dispose();
    this.geometry.dispose();
    this.material.dispose();
    scene.remove(this.group);
  }
}

/** 모서리가 둥근 팬케이크: 반지름 r, 두께 t, 둘레 분할 seg */
function makePancakeGeometry(r: number, t: number, seg: number): THREE.BufferGeometry {
  const edge = Math.min(t * 0.45, r * 0.15);
  const pts: THREE.Vector2[] = [];
  const h = t / 2;
  pts.push(new THREE.Vector2(0, -h));
  pts.push(new THREE.Vector2(r - edge, -h));
  const arc = seg >= 16 ? 4 : 2;
  for (let i = 1; i < arc; i++) {
    const a = -Math.PI / 2 + (Math.PI * i) / arc;
    pts.push(new THREE.Vector2(r - edge + Math.cos(a) * edge, Math.sin(a) * edge));
  }
  pts.push(new THREE.Vector2(r - edge, h));
  pts.push(new THREE.Vector2(0, h));
  const g = new THREE.LatheGeometry(pts, seg);
  g.computeVertexNormals();
  return g;
}

function hash(i: number): number {
  let x = (i + 1) * 2654435761;
  x = ((x >>> 16) ^ x) * 0x45d9f3b;
  x = ((x >>> 16) ^ x) >>> 0;
  return (x % 100000) / 100000;
}
