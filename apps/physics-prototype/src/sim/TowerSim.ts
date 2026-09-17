import type RAPIER_NS from "@dimforge/rapier3d-compat";
import { createRng } from "./rng";
import { computeStackingMetrics, type StackingMetrics } from "./metrics";
import type { TowerData } from "./towerFile";
import {
  DEFAULT_CONFIG,
  STATE_ACTIVE,
  STATE_FROZEN,
  STATE_SURFACE,
  type PancakeState,
  type SimConfig,
  type StepStats,
} from "./types";

type Rapier = typeof RAPIER_NS;
type RigidBody = RAPIER_NS.RigidBody;

const now = (): number =>
  typeof performance !== "undefined" ? performance.now() : Date.now();

/**
 * PANCAKE DROP Phase 0 — 탑 시뮬레이션 코어.
 *
 * 플랜 §6 의 세 가지 상태를 그대로 구현한다.
 *  - ACTIVE : Rapier dynamic body. 떨어지는 중.
 *  - SURFACE: 정착 후 fixed body 로 전환. 콜라이더는 유지 (새 팬케이크가 부딪힐 수 있음).
 *  - FROZEN : 묻힌 팬케이크. body/collider 를 제거하고 transform 만 보관.
 *
 * 렌더러에 의존하지 않는다. 브라우저와 Node 벤치마크가 같은 코드를 쓴다.
 */
export class TowerSim {
  readonly cfg: SimConfig;
  readonly world: RAPIER_NS.World;

  /** 팬케이크 transform. index = pancake id. */
  readonly px: Float32Array;
  readonly py: Float32Array;
  readonly pz: Float32Array;
  readonly qx: Float32Array;
  readonly qy: Float32Array;
  readonly qz: Float32Array;
  readonly qw: Float32Array;
  readonly scale: Float32Array;
  /** 두께 편차 (배율). 렌더링은 (scale, tscale, scale) 비균등 스케일. */
  readonly tscale: Float32Array;
  readonly state: Uint8Array;

  /** 이번 step 에 transform/state 가 바뀐 id 목록 (렌더러 동기화용) */
  dirty: number[] = [];

  private readonly R: Rapier;
  private readonly rng: () => number;
  private readonly bodies = new Map<number, RigidBody>();
  /** body handle → pancake id */
  private readonly bodyIds = new Map<number, number>();
  private readonly settleCounter = new Map<number, number>();
  private readonly activeIds = new Set<number>();
  private readonly surfaceIds = new Set<number>();
  private frozenCount = 0;

  /** XZ 격자별 최고점 (묻힘 판정) 과 그 셀에 속한 SURFACE id 목록 */
  private readonly cellTop = new Map<number, number>();
  private readonly cellMembers = new Map<number, number[]>();
  private readonly cellSize: number;

  private spawnedCount = 0;
  private pendingSpawn = 0;
  private batchStartStep = 0;
  private stepCount = 0;
  private leaks = 0;
  topY = 0;

  constructor(R: Rapier, capacity: number, cfg: Partial<SimConfig> = {}) {
    this.R = R;
    this.cfg = { ...DEFAULT_CONFIG, ...cfg };
    this.rng = createRng(this.cfg.seed);
    this.cellSize = this.cfg.diameter * 0.5;

    this.px = new Float32Array(capacity);
    this.py = new Float32Array(capacity);
    this.pz = new Float32Array(capacity);
    this.qx = new Float32Array(capacity);
    this.qy = new Float32Array(capacity);
    this.qz = new Float32Array(capacity);
    this.qw = new Float32Array(capacity);
    this.scale = new Float32Array(capacity);
    this.tscale = new Float32Array(capacity);
    this.state = new Uint8Array(capacity);

    this.world = new R.World({ x: 0, y: this.cfg.gravity, z: 0 });
    this.world.timestep = this.cfg.dt;
    this.world.integrationParameters.numSolverIterations = this.cfg.solverIterations;
    this.world.integrationParameters.contact_natural_frequency = this.cfg.contactHz;
    this.world.integrationParameters.maxCcdSubsteps = this.cfg.ccdSubsteps;
    this.world.integrationParameters.lengthUnit = this.cfg.lengthUnit > 0 ? this.cfg.lengthUnit : this.cfg.diameter;

    // 바닥: 충분히 넓은 고정 큐브
    // 바닥은 두껍게(10 units): 붕괴 시 솔버가 튕겨낸 팬케이크가 뚫고 나가지 않도록
    const ground = this.world.createRigidBody(R.RigidBodyDesc.fixed().setTranslation(0, -5, 0));
    this.world.createCollider(R.ColliderDesc.cuboid(5000, 5, 5000).setFriction(this.cfg.friction), ground);
  }

  /** 최고점 팬케이크 id (spawnMode 'top' 의 기준) */
  private topId = -1;
  /** 직전에 스폰한 id. 새 스폰은 항상 이 팬케이크의 현재 위치보다 위에 놓아 겹침을 막는다. */
  private lastSpawnId = -1;

  get capacity(): number {
    return this.px.length;
  }
  /** id 팬케이크의 실제 반두께 (두께 편차 반영) */
  halfTh(id: number): number {
    return (this.cfg.thickness * this.tscale[id]) / 2;
  }
  /** id 팬케이크의 실제 반지름 (크기 편차 반영) */
  radius(id: number): number {
    return (this.cfg.diameter * this.scale[id]) / 2;
  }
  get spawned(): number {
    return this.spawnedCount;
  }
  get activeCount(): number {
    return this.activeIds.size;
  }
  get surfaceCount(): number {
    return this.surfaceIds.size;
  }
  get frozen(): number {
    return this.frozenCount;
  }
  get leakCount(): number {
    return this.leaks;
  }
  get steps(): number {
    return this.stepCount;
  }
  /** 실제 탑 높이 (m). 플랜 §13: 개수 × 두께가 아니라 실제 최고점. */
  get towerHeightMeters(): number {
    return (this.topY * this.cfg.unitCm) / 100;
  }

  /** 다음 Drop 배치를 예약한다. 실제 스폰은 step() 에서 spawnPerStep 씩 흘려보낸다. */
  queueBatch(n: number = this.cfg.batchSize): number {
    const room = this.capacity - this.spawnedCount - this.pendingSpawn;
    const count = Math.max(0, Math.min(n, room));
    this.pendingSpawn += count;
    this.batchStartStep = this.stepCount;
    return count;
  }

  get batchInFlight(): boolean {
    return this.pendingSpawn > 0 || this.activeIds.size > 0;
  }

  /** 물리 1 step. 스폰 → world.step → 정착/묻힘 판정. */
  step(): StepStats {
    const t0 = now();
    this.dirty.length = 0;

    const toSpawn = Math.min(this.pendingSpawn, this.cfg.spawnPerStep);
    for (let i = 0; i < toSpawn; i++) this.spawnOne();
    this.pendingSpawn -= toSpawn;

    this.world.step();
    this.stepCount++;

    let settled = 0;
    let frozenNow = 0;
    const forceSettle =
      this.pendingSpawn === 0 && this.stepCount - this.batchStartStep > this.cfg.maxStepsPerBatch;

    for (const id of this.activeIds) {
      const body = this.bodies.get(id)!;
      const t = body.translation();
      this.px[id] = t.x;
      this.py[id] = t.y;
      this.pz[id] = t.z;
      const r = body.rotation();
      this.qx[id] = r.x;
      this.qy[id] = r.y;
      this.qz[id] = r.z;
      this.qw[id] = r.w;
      this.dirty.push(id);

      if (t.y < -1 || Number.isNaN(t.y)) {
        // 바닥을 뚫고 떨어짐 = 터널링. 정확성 지표로 기록하고 제거.
        this.leaks++;
        this.world.removeRigidBody(body);
        this.bodies.delete(id);
        this.bodyIds.delete(body.handle);
        this.activeIds.delete(id);
        this.settleCounter.delete(id);
        this.state[id] = STATE_FROZEN;
        this.frozenCount++;
        continue;
      }

      const lv = body.linvel();
      const av = body.angvel();
      const speed2 = lv.x * lv.x + lv.y * lv.y + lv.z * lv.z;
      const slow =
        speed2 < this.cfg.settleLinVel ** 2 &&
        av.x * av.x + av.y * av.y + av.z * av.z < this.cfg.settleAngVel ** 2;
      const c = slow ? (this.settleCounter.get(id) ?? 0) + 1 : 0;
      this.settleCounter.set(id, c);

      let stickAllowed = this.cfg.stickOnContact && speed2 < this.cfg.stickMaxSpeed ** 2;
      if (stickAllowed) {
        const o = this.releaseOrigin.get(id);
        if (o) {
          // Release 된 팬케이크는 출발점보다 1직경 이상 아래로 내려온 뒤에만 시럽 규칙으로 재정착한다.
          // (기둥 하부처럼 내려갈 수 없는 것은 속도 기준으로 정착한다)
          if (o[1] - t.y < this.cfg.diameter) stickAllowed = false;
          else this.releaseOrigin.delete(id);
        }
      }
      const stick = stickAllowed && this.touchesFixed(body);

      const aboveGround = t.y > this.halfTh(id) - this.cfg.thickness * this.cfg.stickMaxPenetration;
      if (aboveGround && (stick || body.isSleeping() || c >= this.cfg.settleFrames || forceSettle)) {
        if (this.cfg.stickOnContact && this.cfg.drape > 0) {
          if (!stick) this.lastSupport = null;
          this.drapeOnto(id, body, this.lastSupport);
          const nt = body.translation();
          const nr = body.rotation();
          this.px[id] = nt.x; this.py[id] = nt.y; this.pz[id] = nt.z;
          this.qx[id] = nr.x; this.qy[id] = nr.y; this.qz[id] = nr.z; this.qw[id] = nr.w;
        }
        this.settle(id, body);
        settled++;
        frozenNow += this.freezeBuried(id);
      }
    }

    const stepMs = now() - t0;
    return {
      step: this.stepCount,
      stepMs,
      active: this.activeIds.size,
      surface: this.surfaceIds.size,
      frozen: this.frozenCount,
      spawned: this.spawnedCount,
      settledThisStep: settled,
      frozenThisStep: frozenNow,
      topY: this.topY,
      leaks: this.leaks,
    };
  }

  /**
   * Collapse Day 테스트 (플랜 §49 / COLLAPSE_DAY.md §5).
   * SURFACE 는 dynamic 으로 되돌리고, FROZEN 은 body 를 다시 만든다.
   * ids 를 주지 않으면 전체 Release. 반환값 = Release 된 개수.
   */
  release(ids?: Iterable<number>): number {
    const R = this.R;
    const list = ids ?? this.allSettledIds();
    let n = 0;
    for (const id of list) {
      const s = this.state[id];
      if (s === STATE_SURFACE) {
        const body = this.bodies.get(id)!;
        body.setBodyType(R.RigidBodyType.Dynamic, true);
        this.surfaceIds.delete(id);
        this.removeFromCell(id);
      } else if (s === STATE_FROZEN) {
        this.createBody(id, this.px[id], this.py[id], this.pz[id], {
          x: this.qx[id],
          y: this.qy[id],
          z: this.qz[id],
          w: this.qw[id],
        });
        this.frozenCount--;
      } else {
        continue;
      }
      this.state[id] = STATE_ACTIVE;
      this.activeIds.add(id);
      this.settleCounter.set(id, 0);
      this.releaseOrigin.set(id, [this.px[id], this.py[id], this.pz[id]]);
      // Release 된 팬케이크는 CCD 를 끈다: Rapier 0.20 의 CCD 가 대규모 동시 접촉에서 간헐적으로 패닉(unreachable)을 일으킨다.
      this.bodies.get(id)!.enableCcd(false);
      if (this.cfg.releaseKick > 0) {
        const b = this.bodies.get(id)!;
        const a = this.rng() * Math.PI * 2;
        const k = this.cfg.releaseKick * (0.5 + this.rng());
        b.setLinvel({ x: Math.cos(a) * k, y: 0, z: Math.sin(a) * k }, true);
        b.setAngvel({ x: (this.rng() - 0.5) * 2, y: 0, z: (this.rng() - 0.5) * 2 }, true);
      }
      this.dirty.push(id);
      n++;
    }
    if (n > 0) {
      // 높이맵은 전부 다시 계산해야 하므로 비운다. 정착 시 다시 채워진다.
      this.cellTop.clear();
      this.cellMembers.clear();
      for (const id of this.surfaceIds) this.addToCell(id);
      this.recomputeTop();
      this.batchStartStep = this.stepCount;
    }
    return n;
  }

  /** y 가 높은 순으로 정렬한 정착 id. Slab 단위 Release 에 사용. */
  settledIdsTopDown(): number[] {
    const ids = Array.from(this.allSettledIds());
    ids.sort((a, b) => this.py[b] - this.py[a]);
    return ids;
  }

  /** 탑 footprint 반경 (units): 정착 팬케이크 중 XZ 원점에서 가장 먼 것 */
  footprintRadius(): number {
    let r2 = 0;
    for (let id = 0; id < this.spawnedCount; id++) {
      if (this.state[id] === STATE_ACTIVE) continue;
      const d = this.px[id] * this.px[id] + this.pz[id] * this.pz[id];
      if (d > r2) r2 = d;
    }
    return Math.sqrt(r2);
  }

  /** 정착한 팬케이크만 담은 스냅샷 (계측/파일 저장용). 서버가 클라이언트에 주는 것과 같은 내용. */
  snapshot(): TowerData {
    const n = this.spawnedCount;
    return {
      count: n,
      diameter: this.cfg.diameter,
      thickness: this.cfg.thickness,
      unitCm: this.cfg.unitCm,
      px: this.px.slice(0, n), py: this.py.slice(0, n), pz: this.pz.slice(0, n),
      qx: this.qx.slice(0, n), qy: this.qy.slice(0, n), qz: this.qz.slice(0, n), qw: this.qw.slice(0, n),
      scale: this.scale.slice(0, n), tscale: this.tscale.slice(0, n),
    };
  }

  /** 현재 탑의 Stacking 품질 계측 (ACTIVE 제외) */
  metrics(): StackingMetrics {
    return computeStackingMetrics({ ...this.snapshot(), include: (id) => this.state[id] !== STATE_ACTIVE });
  }

  /** 리소스 해제 */
  free(): void {
    this.world.free();
  }

  // ---------------------------------------------------------------- 내부

  private *allSettledIds(): Iterable<number> {
    for (let id = 0; id < this.spawnedCount; id++) {
      if (this.state[id] !== STATE_ACTIVE) yield id;
    }
  }

  private spawnOne(): void {
    const id = this.spawnedCount++;
    const c = this.cfg;
    const rng = this.rng;

    const ang = rng() * Math.PI * 2;
    const rad = c.spawnSpread * Math.sqrt(rng());
    // 'top' 모드: 최고점 팬케이크 중심 위. spawnRecenter 만큼 탑 축(원점) 쪽으로 당겨 장기 표류를 제한한다.
    const follow = c.spawnMode === "top" && this.topId >= 0;
    const baseX = follow ? this.px[this.topId] * (1 - c.spawnRecenter) : 0;
    const baseZ = follow ? this.pz[this.topId] * (1 - c.spawnRecenter) : 0;
    const x = baseX + Math.cos(ang) * rad;
    const z = baseZ + Math.sin(ang) * rad;
    let y = this.topY + c.spawnClearance + c.thickness;
    if (this.lastSpawnId >= 0 && this.state[this.lastSpawnId] === STATE_ACTIVE) {
      // 직전 스폰이 아직 떨어지는 중이면 그 위에 간격(두께의 4배)을 두고 쌓는다
      y = Math.max(y, this.py[this.lastSpawnId] + c.thickness * 4);
    }
    this.lastSpawnId = id;

    // 작은 기울기 + 임의 yaw
    const tilt = (rng() * 2 - 1) * c.spawnTilt;
    const tiltAxis = rng() * Math.PI * 2;
    const yaw = rng() * Math.PI * 2;
    const q = mulQuat(
      axisAngle(0, 1, 0, yaw),
      axisAngle(Math.cos(tiltAxis), 0, Math.sin(tiltAxis), tilt),
    );

    this.scale[id] = 1 + (rng() * 2 - 1) * c.sizeJitter;
    this.tscale[id] = 1 + (rng() * 2 - 1) * c.thicknessJitter;
    this.state[id] = STATE_ACTIVE;
    this.createBody(id, x, y, z, q);
    this.activeIds.add(id);
    this.settleCounter.set(id, 0);
    this.px[id] = x;
    this.py[id] = y;
    this.pz[id] = z;
    this.qx[id] = q.x;
    this.qy[id] = q.y;
    this.qz[id] = q.z;
    this.qw[id] = q.w;
    this.dirty.push(id);
  }

  private createBody(id: number, x: number, y: number, z: number, q: Quat): RigidBody {
    const R = this.R;
    const c = this.cfg;
    const desc = R.RigidBodyDesc.dynamic()
      .setTranslation(x, y, z)
      .setRotation(q)
      .setAngularDamping(c.angularDamping)
      .setLinearDamping(c.linearDamping)
      .setCcdEnabled(c.ccd);
    const body = this.world.createRigidBody(desc);
    const s = this.scale[id];
    const halfH = this.halfTh(id);
    const radius = (c.diameter * s) / 2;
    const col = (c.edgeRadius > 0
      ? R.ColliderDesc.roundCylinder(halfH - c.edgeRadius, radius - c.edgeRadius, c.edgeRadius)
      : R.ColliderDesc.cylinder(halfH, radius))
      .setFriction(c.friction)
      .setRestitution(c.restitution)
      .setDensity(c.density);
    this.world.createCollider(col, body);
    this.bodies.set(id, body);
    this.bodyIds.set(body.handle, id);
    return body;
  }

  private settle(id: number, body: RigidBody): void {
    body.setBodyType(this.R.RigidBodyType.Fixed, false);
    this.activeIds.delete(id);
    this.settleCounter.delete(id);
    this.releaseOrigin.delete(id);
    this.surfaceIds.add(id);
    this.state[id] = STATE_SURFACE;
    this.addToCell(id);
    const top = this.py[id] + this.halfTh(id);
    if (top > this.topY) {
      this.topY = top;
      this.topId = id;
    }
  }

  /**
   * 시럽 규칙: 고정 콜라이더(바닥/SURFACE)와 실제 접촉점이 있고,
   * 침투 깊이가 허용치(두께의 stickMaxPenetration 배) 이내인가.
   * 깊이 파고든 상태에서 고정하면 겹친 채로 굳어 탑 높이가 왜곡되므로
   * 솔버가 밀어낼 때까지 기다린다.
   */
  private touchesFixed(body: RigidBody): boolean {
    const col = body.collider(0);
    const maxPen = -this.cfg.thickness * this.cfg.stickMaxPenetration;
    let touching = false;
    let tooDeep = false;
    let supportY = -Infinity;
    let support: RigidBody | null = null;
    this.world.contactPairsWith(col, (other) => {
      const parent = other.parent();
      if (parent && parent.bodyType() === this.R.RigidBodyType.Dynamic) return;
      this.world.contactPair(col, other, (manifold) => {
        const n = manifold.numContacts();
        for (let i = 0; i < n; i++) {
          if (manifold.contactDist(i) < maxPen) tooDeep = true;
        }
        if (n > 0) {
          touching = true;
          const y = parent ? parent.translation().y : -Infinity;
          if (y > supportY) {
            supportY = y;
            support = parent ?? null;
          }
        }
      });
    });
    if (!touching) return false;
    // 드레이프가 켜져 있으면 침투 깊이와 무관하게 받침 위로 스냅하므로 정착 가능.
    // 드레이프가 꺼진 순수 강체 모드에서만 깊은 침투 상태의 정착을 거부한다.
    if (tooDeep && this.cfg.drape <= 0) return false;
    this.lastSupport = support;
    return true;
  }

  /** touchesFixed 가 찾은 가장 높은 받침 (null = 바닥) */
  private lastSupport: RigidBody | null = null;
  /** Release 된 팬케이크의 출발 위치. 1직경 이상 이동하기 전에는 시럽 규칙으로 재정착하지 않는다. */
  private readonly releaseOrigin = new Map<number, [number, number, number]>();

  /**
   * 드레이프 규칙: 받침의 면에 맞춰 눕히고, 받침 위에 정확히 얹는다.
   * 강체 원반은 받침 기울기를 그대로 물려받아 층마다 누적되므로,
   * 실제 팬케이크의 순응성을 이 규칙으로 대신한다 (플랜 §7 세계 규칙).
   */
  private drapeOnto(id: number, body: RigidBody, support: RigidBody | null): void {
    const c = this.cfg;
    const t = body.translation();
    const own = body.rotation();
    const yaw = yawOf(own);

    // 받침의 up 벡터 (바닥이면 월드 up)
    let ux = 0, uy = 1, uz = 0;
    let sx = 0, sy = 0, sz = 0, sHalf = 0;
    const sid = support ? this.bodyIds.get(support.handle) : undefined;
    if (sid === undefined) support = null; // 팬케이크가 아닌 받침 = 바닥
    if (support && sid !== undefined) {
      const sr = support.rotation();
      const u = rotateY(sr);
      ux = u.x; uy = u.y; uz = u.z;
      const st = support.translation();
      sx = st.x; sy = st.y; sz = st.z;
      sHalf = this.halfTh(sid);
    }
    // 목표 up = drape·월드up + (1-drape)·(받침 up 과 자기 착지 up 의 평균)
    // 받침 기울기는 일부만 물려받고, 착지 순간의 자기 기울기도 일부 남긴다. 기울기는 층마다 누적되지 않고 유계.
    const ou = rotateY(own);
    const bx = (ux + ou.x) / 2, by = (uy + ou.y) / 2, bz = (uz + ou.z) / 2;
    let tx = bx * (1 - c.drape), ty = by * (1 - c.drape) + c.drape, tz = bz * (1 - c.drape);
    const tl = Math.hypot(tx, ty, tz) || 1;
    tx /= tl; ty /= tl; tz /= tl;
    let tiltQ = fromTo(0, 1, 0, tx, ty, tz);
    if (c.settleTiltJitter > 0) {
      // 시각적 변화용 소량의 무작위 기울기 (물리에는 다음 착지면의 미세한 기울기로만 영향)
      const ja = this.rng() * Math.PI * 2;
      const jt = (this.rng() * 2 - 1) * c.settleTiltJitter;
      tiltQ = mulQuat(axisAngle(Math.cos(ja), 0, Math.sin(ja), jt), tiltQ);
    }
    const q = mulQuat(tiltQ, axisAngle(0, 1, 0, yaw));

    // 높이: 받침 중심에서 (받침 법선 u 와 자기 법선 t 의 평균 법선 n) 방향으로 정확히 반두께 합만큼 떨어지도록 y 를 푼다.
    // (p - s) · n = sHalf + ownHalf,  p = (x, y, z).  y 만 맞추던 이전 방식은 기울기가 다를 때 가장자리가 받침에 파고들었다.
    const ownHalf = this.halfTh(id);
    let nx = ux + tx, ny = uy + ty, nz = uz + tz;
    const nl = Math.hypot(nx, ny, nz) || 1;
    nx /= nl; ny /= nl; nz /= nl;
    let y: number;
    if (support && ny > 0.5) {
      y = sy + ((sHalf + ownHalf) - nx * (t.x - sx) - nz * (t.z - sz)) / ny;
    } else if (support) {
      y = t.y; // 받침이 거의 세워져 있으면 스냅하지 않음
    } else {
      y = ownHalf / Math.max(0.5, ty); // 바닥: 자기 기울기만큼 살짝 띄움
    }
    // 높이맵 보정: 이 XZ 를 덮는 고정 팬케이크의 최고점보다 아래로는 절대 놓지 않는다.
    // (CCD 를 뚫고 지나간 경우나 받침 선택이 어긋난 경우의 겹침 방지)
    const cellTop = this.cellTop.get(cellKey(this.cellOf(t.x), this.cellOf(t.z)));
    if (cellTop !== undefined && y - ownHalf < cellTop - this.cfg.thickness * this.cfg.stickMaxPenetration) {
      y = cellTop + ownHalf;
    }
    body.setTranslation({ x: t.x, y, z: t.z }, false);
    body.setRotation(q, false);
  }

  /** id 가 정착한 셀 주변에서 묻힌 SURFACE 팬케이크를 FROZEN 으로 바꾼다. */
  private freezeBuried(id: number): number {
    if (!this.cfg.freezeEnabled) return 0;
    const cx = this.cellOf(this.px[id]);
    const cz = this.cellOf(this.pz[id]);
    let n = 0;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        const key = cellKey(cx + dx, cz + dz);
        const members = this.cellMembers.get(key);
        if (!members) continue;
        const cellTop = this.cellTop.get(key) ?? -Infinity;
        for (let i = members.length - 1; i >= 0; i--) {
          const m = members[i];
          if (m === id) continue;
          const mTop = this.py[m] + this.halfTh(m);
          if (cellTop - mTop >= this.cfg.freezeDepth) {
            this.freeze(m);
            members.splice(i, 1);
            n++;
          }
        }
      }
    }
    return n;
  }

  private freeze(id: number): void {
    const body = this.bodies.get(id);
    if (body) {
      this.bodyIds.delete(body.handle);
      this.world.removeRigidBody(body);
      this.bodies.delete(id);
    }
    this.surfaceIds.delete(id);
    this.state[id] = STATE_FROZEN;
    this.frozenCount++;
    this.dirty.push(id);
  }

  private cellOf(v: number): number {
    return Math.floor(v / this.cellSize);
  }

  private addToCell(id: number): void {
    const cx = this.cellOf(this.px[id]);
    const cz = this.cellOf(this.pz[id]);
    const top = this.py[id] + this.halfTh(id);
    const r = Math.ceil((this.cfg.diameter * this.scale[id]) / 2 / this.cellSize);
    // footprint 가 덮는 셀들의 최고점을 갱신한다
    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        const key = cellKey(cx + dx, cz + dz);
        const prev = this.cellTop.get(key);
        if (prev === undefined || top > prev) this.cellTop.set(key, top);
      }
    }
    const key = cellKey(cx, cz);
    let members = this.cellMembers.get(key);
    if (!members) {
      members = [];
      this.cellMembers.set(key, members);
    }
    members.push(id);
  }

  private removeFromCell(id: number): void {
    const key = cellKey(this.cellOf(this.px[id]), this.cellOf(this.pz[id]));
    const members = this.cellMembers.get(key);
    if (!members) return;
    const i = members.indexOf(id);
    if (i >= 0) members.splice(i, 1);
  }

  private recomputeTop(): void {
    let top = 0;
    let topId = -1;
    for (let id = 0; id < this.spawnedCount; id++) {
      if (this.state[id] === STATE_ACTIVE) continue;
      const t = this.py[id] + this.halfTh(id);
      if (t > top) {
        top = t;
        topId = id;
      }
    }
    this.topY = top;
    this.topId = topId;
  }
}

interface Quat {
  x: number;
  y: number;
  z: number;
  w: number;
}

function axisAngle(ax: number, ay: number, az: number, angle: number): Quat {
  const s = Math.sin(angle / 2);
  return { x: ax * s, y: ay * s, z: az * s, w: Math.cos(angle / 2) };
}

function mulQuat(a: Quat, b: Quat): Quat {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  };
}

/** 쿼터니언으로 (0,1,0) 을 회전한 벡터 */
function rotateY(q: Quat): { x: number; y: number; z: number } {
  // v' = q (0,1,0) q*  — 표준 공식. (부호를 틀리면 드레이프가 받침 기울기를 거울상으로 물려받는다)
  return {
    x: 2 * (q.x * q.y - q.w * q.z),
    y: 1 - 2 * (q.x * q.x + q.z * q.z),
    z: 2 * (q.y * q.z + q.w * q.x),
  };
}

/** 로컬 X 축의 수평 투영으로 yaw 추출 */
function yawOf(q: Quat): number {
  const xx = 1 - 2 * (q.y * q.y + q.z * q.z);
  const xz = 2 * (q.x * q.z - q.w * q.y);
  return Math.atan2(-xz, xx);
}

/** 단위벡터 a 를 b 로 보내는 최소 회전 */
function fromTo(ax: number, ay: number, az: number, bx: number, by: number, bz: number): Quat {
  const d = ax * bx + ay * by + az * bz;
  if (d > 0.999999) return { x: 0, y: 0, z: 0, w: 1 };
  if (d < -0.999999) return { x: 1, y: 0, z: 0, w: 0 };
  const cx = ay * bz - az * by, cy = az * bx - ax * bz, cz = ax * by - ay * bx;
  const w = 1 + d;
  const l = Math.hypot(cx, cy, cz, w);
  return { x: cx / l, y: cy / l, z: cz / l, w: w / l };
}

function cellKey(cx: number, cz: number): number {
  // 32비트 정수 두 개를 하나의 안전한 정수 키로 결합
  return (cx + 1_000_000) * 4_000_000 + (cz + 1_000_000);
}

export { STATE_ACTIVE, STATE_SURFACE, STATE_FROZEN };
export type { PancakeState };
