import * as THREE from "three";
import { TRANSFORM_STRIDE, type Tower } from "tower-engine";
import type { ChunkRenderer } from "./chunkRenderer";

/**
 * Drop Replay (Phase 1 §25, §26).
 * 서버 final transform + 클라이언트 애니메이션 seed 로 낙하를 연출한다. 물리는 돌리지 않는다.
 * 종료 시 렌더 transform 은 서버 final 값으로 정확히 수렴한다 (Phase 0.75 오차 0 검증을 regression 으로 유지).
 */
export interface ReplayParams {
  durationMs: number;
  /** 시작 높이 (final 위로, world units) */
  dropHeight: number;
  /** 순차 낙하 비율 0..1 (0 = 동시, 1 = 완전 순차) */
  stagger: number;
  seed: number;
}
export const DEFAULT_REPLAY: ReplayParams = { durationMs: 4000, dropHeight: 30, stagger: 0.3, seed: 1 };

function hash01(seed: number, k: number): number {
  let x = (Math.imul(seed + 1, 2654435761) ^ Math.imul(k + 1, 0x9e3779b1)) >>> 0;
  x = Math.imul(x ^ (x >>> 15), 0x85ebca6b) >>> 0;
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35) >>> 0;
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
}

/** k 번째(0..n-1) 팬케이크의 지역 진행률. u 는 전체 진행률 0..1. */
export function replayLocalProgress(k: number, n: number, u: number, stagger: number): number {
  const offset = n > 1 ? (k / (n - 1)) * stagger : 0;
  return Math.min(1, Math.max(0, (u * (1 + stagger) - offset)));
}

export interface Pose { p: [number, number, number]; q: [number, number, number, number] }

/**
 * 지역 진행률 local 에서의 pose. local >= 1 이면 final 을 그대로(참조가 아니라 값 복사) 반환한다.
 * 낙하: ease-out(중력 느낌). 회전: seed 기반 흔들림이 0 으로 수렴.
 */
export function replayPose(final: Pose, start: Pose, local: number, seed: number, k: number): Pose {
  if (local >= 1) return { p: [final.p[0], final.p[1], final.p[2]], q: [final.q[0], final.q[1], final.q[2], final.q[3]] };
  const e = 1 - (1 - local) * (1 - local);
  const p: [number, number, number] = [start.p[0] + (final.p[0] - start.p[0]) * e, start.p[1] + (final.p[1] - start.p[1]) * e, start.p[2] + (final.p[2] - start.p[2]) * e];
  const wob = (1 - e) * 0.35;
  const a = hash01(seed, k) * Math.PI * 2;
  const q0 = new THREE.Quaternion(final.q[0], final.q[1], final.q[2], final.q[3]);
  const w = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(Math.cos(a), 0, Math.sin(a)), wob * (0.5 + hash01(seed, k + 7)));
  const q = w.multiply(q0).normalize();
  return { p, q: [q.x, q.y, q.z, q.w] };
}

export interface ReplayReport { animated: number; durationMs: number; maxPosError: number; maxQuatError: number; converged: boolean }

export class DropReplay {
  private readonly finals: Float32Array;
  private readonly starts: Float32Array;
  private readonly n: number;
  private t0 = -1;
  private done = false;
  private report: ReplayReport | null = null;
  /** chunkId → 이 replay 에 속한 instance index 목록 */
  private readonly perChunk = new Map<number, number[]>();

  constructor(readonly tower: Tower, readonly renderer: ChunkRenderer, readonly startSerial: number, readonly endSerial: number, readonly params: ReplayParams = DEFAULT_REPLAY) {
    this.n = endSerial - startSerial + 1;
    this.finals = new Float32Array(this.n * TRANSFORM_STRIDE);
    this.starts = new Float32Array(this.n * TRANSFORM_STRIDE);
    for (let k = 0; k < this.n; k++) {
      const serial = startSerial + k;
      const cid = tower.chunkIdOf(serial);
      const chunk = tower.chunk(cid) ?? tower.loadChunkSync(cid);
      if (!chunk) throw new Error(`chunk ${cid} not loaded`);
      const idx = serial - chunk.startSerial;
      const o = idx * TRANSFORM_STRIDE, d = k * TRANSFORM_STRIDE;
      for (let j = 0; j < TRANSFORM_STRIDE; j++) this.finals[d + j] = chunk.transforms[o + j];
      this.starts.set(this.finals.subarray(d, d + TRANSFORM_STRIDE), d);
      this.starts[d + 1] = this.finals[d + 1] + params.dropHeight + k * 0.02; // 위에서, 살짝 간격
      let list = this.perChunk.get(cid);
      if (!list) { list = []; this.perChunk.set(cid, list); }
      list.push(idx);
    }
  }

  get finished(): boolean { return this.done; }
  get result(): ReplayReport | null { return this.report; }

  /** 매 프레임. 완료되면 true. */
  update(nowMs: number): boolean {
    if (this.done) return true;
    if (this.t0 < 0) this.t0 = nowMs;
    const u = Math.min(1, (nowMs - this.t0) / this.params.durationMs);
    for (let k = 0; k < this.n; k++) {
      const serial = this.startSerial + k;
      const cid = this.tower.chunkIdOf(serial);
      const chunk = this.tower.chunk(cid)!;
      const o = (serial - chunk.startSerial) * TRANSFORM_STRIDE, d = k * TRANSFORM_STRIDE;
      const local = replayLocalProgress(k, this.n, u, this.params.stagger);
      const final: Pose = { p: [this.finals[d], this.finals[d + 1], this.finals[d + 2]], q: [this.finals[d + 3], this.finals[d + 4], this.finals[d + 5], this.finals[d + 6]] };
      const start: Pose = { p: [this.starts[d], this.starts[d + 1], this.starts[d + 2]], q: final.q };
      const pose = replayPose(final, start, local, this.params.seed, k);
      chunk.transforms[o] = pose.p[0]; chunk.transforms[o + 1] = pose.p[1]; chunk.transforms[o + 2] = pose.p[2];
      chunk.transforms[o + 3] = pose.q[0]; chunk.transforms[o + 4] = pose.q[1]; chunk.transforms[o + 5] = pose.q[2]; chunk.transforms[o + 6] = pose.q[3];
    }
    for (const [cid, idxs] of this.perChunk) this.renderer.refreshInstances(cid, idxs);
    if (u >= 1) this.finish();
    return this.done;
  }

  /** 서버 final 값으로 정확히 되돌리고 렌더 행렬과 비교 */
  private finish(): void {
    for (let k = 0; k < this.n; k++) {
      const serial = this.startSerial + k;
      const chunk = this.tower.chunk(this.tower.chunkIdOf(serial))!;
      const o = (serial - chunk.startSerial) * TRANSFORM_STRIDE, d = k * TRANSFORM_STRIDE;
      for (let j = 0; j < TRANSFORM_STRIDE; j++) chunk.transforms[o + j] = this.finals[d + j];
    }
    for (const [cid, idxs] of this.perChunk) this.renderer.refreshInstances(cid, idxs);
    const m = new THREE.Matrix4(), p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
    let maxPos = 0, maxQuat = 0, checked = 0;
    for (let k = 0; k < this.n; k++) {
      const serial = this.startSerial + k;
      const cid = this.tower.chunkIdOf(serial);
      const chunk = this.tower.chunk(cid)!;
      if (!this.renderer.readInstanceMatrix(cid, serial - chunk.startSerial, m)) continue;
      m.decompose(p, q, s);
      const d = k * TRANSFORM_STRIDE;
      maxPos = Math.max(maxPos, Math.hypot(p.x - this.finals[d], p.y - this.finals[d + 1], p.z - this.finals[d + 2]));
      const fq = [this.finals[d + 3], this.finals[d + 4], this.finals[d + 5], this.finals[d + 6]];
      const dq = Math.min(Math.hypot(q.x - fq[0], q.y - fq[1], q.z - fq[2], q.w - fq[3]), Math.hypot(q.x + fq[0], q.y + fq[1], q.z + fq[2], q.w + fq[3]));
      maxQuat = Math.max(maxQuat, dq);
      checked++;
    }
    this.report = { animated: checked, durationMs: this.params.durationMs, maxPosError: maxPos, maxQuatError: maxQuat, converged: checked === this.n && maxPos < 1e-4 && maxQuat < 1e-4 };
    this.done = true;
  }
}
