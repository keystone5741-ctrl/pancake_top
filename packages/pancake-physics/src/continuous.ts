import type RAPIER_NS from "@dimforge/rapier3d-compat";
import type { DropId, TowerData } from "pancake-core";
import { TowerSim } from "./TowerSim";
import type { SimConfig } from "./types";
import { STATE_ACTIVE } from "./types";
import { TopNSurfaceProvider, type SurfaceColliderProvider } from "./surface";

export type DropState = "OPEN" | "SIMULATING" | "CLOSING" | "FINALIZING" | "READY" | "RELEASED";

export interface DropRecord {
  id: DropId;
  state: DropState;
  startSerial: number;
  /** 마지막 serial (포함). 아직 팬케이크가 없으면 startSerial - 1 */
  endSerial: number;
  count: number;
  settled: number;
  heightBefore: number;
  heightAfter: number | null;
  createdAt: number;
  closedAt: number | null;
  readyAt: number | null;
  releasedAt: number | null;
  simulationMs: number;
}

export interface DropResult {
  dropId: DropId;
  total: number;
  startSerial: number;
  endSerial: number;
  finalTransforms: TowerData;
  heightBefore: number;
  heightAfter: number;
  simulationMs: number;
}

export interface ContinuousOptions {
  /** 총 팬케이크 상한 (base + 새 Drop 들) */
  capacity: number;
  base?: TowerData;
  surfaceProvider?: SurfaceColliderProvider;
  config?: Partial<SimConfig>;
  now?: () => number;
}

const now = (): number => (typeof performance !== "undefined" ? performance.now() : Date.now());

/**
 * Continuous Drop Simulation (Phase 1 §18~§21).
 * 구매가 들어오는 즉시 큐에 넣고 계산을 진행한다. Drop 은 OPEN → SIMULATING → CLOSING → FINALIZING → READY → RELEASED.
 * 물리 시간(계산 완료)과 시각 시간(RELEASED) 은 분리된다 (§20).
 *
 * 규칙:
 *  - OPEN 인 Drop 은 하나뿐. 다음 Drop 은 현재 Drop 이 닫힌 뒤(CLOSING 이후) createDrop 으로 연다.
 *  - 팬케이크 serial 은 enqueue 순서 = Drop 순서. 이전 Drop 의 팬케이크가 모두 정착해야 다음 Drop 이 그 위에 쌓인다.
 *  - 물리 규칙은 TowerSim 그대로 (Phase 0.5 동결).
 */
export class ContinuousDropSimulator {
  readonly sim: TowerSim;
  readonly surfaceProvider: SurfaceColliderProvider;
  readonly baseCount: number;
  readonly surfaceColliderCount: number;
  private readonly drops = new Map<DropId, DropRecord>();
  private readonly order: DropId[] = [];
  private readonly clock: () => number;
  private seq = 0;
  /** 아직 물리 큐에 넣지 않은 팬케이크 수 */
  private queued = 0;

  private feed(): void {
    if (this.queued > 0 && !this.sim.batchInFlight) {
      const n = Math.min(this.sim.cfg.batchSize, this.queued);
      const got = this.sim.queueBatch(n);
      this.queued -= got;
    }
  }

  constructor(R: typeof RAPIER_NS, opts: ContinuousOptions) {
    this.clock = opts.now ?? now;
    this.surfaceProvider = opts.surfaceProvider ?? new TopNSurfaceProvider(64);
    this.sim = new TowerSim(R, opts.capacity, opts.config ?? {});
    if (opts.base) {
      const ids = this.surfaceProvider.getSurfaceColliders(opts.base);
      this.baseCount = this.sim.loadBase(opts.base, ids);
      this.surfaceColliderCount = ids.length;
    } else { this.baseCount = 0; this.surfaceColliderCount = 0; }
  }

  get drop(): DropRecord | null {
    const id = this.order[this.order.length - 1];
    return id ? this.drops.get(id)! : null;
  }
  get(dropId: DropId): DropRecord | undefined { return this.drops.get(dropId); }
  list(): DropRecord[] { return this.order.map((id) => this.drops.get(id)!); }
  get towerHeight(): number { return this.sim.topY; }
  get spawned(): number { return this.sim.spawned; }

  /** 새 Drop 을 OPEN 으로 만든다. 이전 Drop 이 아직 OPEN/SIMULATING 이면 오류. */
  createDrop(id?: DropId): DropRecord {
    const cur = this.drop;
    if (cur && (cur.state === "OPEN" || cur.state === "SIMULATING")) throw new Error(`drop ${cur.id} is still open`);
    const dropId = id ?? `DROP_${String(++this.seq).padStart(4, "0")}`;
    const start = this.sim.spawned + this.pendingCount();
    const rec: DropRecord = { id: dropId, state: "OPEN", startSerial: start, endSerial: start - 1, count: 0, settled: 0, heightBefore: this.sim.topY, heightAfter: null, createdAt: this.clock(), closedAt: null, readyAt: null, releasedAt: null, simulationMs: 0 };
    this.drops.set(dropId, rec);
    this.order.push(dropId);
    return rec;
  }

  private pendingCount(): number {
    // 아직 스폰되지 않은(큐에 있는) 팬케이크 수 = 등록된 총량 - spawned
    let total = this.baseCount;
    for (const d of this.drops.values()) total += d.count;
    return total - this.sim.spawned;
  }

  /** 구매 도착: 즉시 시뮬레이션 큐에 추가 (§19 OPEN). 반환: 부여된 serial 범위. */
  enqueuePancakes(dropId: DropId, n: number): { startSerial: number; endSerial: number } {
    const d = this.drops.get(dropId);
    if (!d) throw new Error(`unknown drop ${dropId}`);
    if (d.state !== "OPEN" && d.state !== "SIMULATING") throw new Error(`drop ${dropId} is ${d.state}; new purchases go to the next drop`);
    if (n <= 0) throw new Error("n must be positive");
    if (this.sim.spawned + this.pendingCount() + n > this.sim.capacity) throw new Error(`capacity exceeded`);
    // 물리에는 batchSize(기본 500) 단위로만 공급한다. 한 배치가 정착한 뒤 다음 배치를 넣는 Phase 0.5 조건을
    // 구매 도착 패턴과 무관하게 유지하기 위해서다 (한 번에 큐에 다 넣으면 공중의 활성 기둥이 커져 침투가 늘어난다).
    this.queued += n;
    this.feed();
    const first = d.endSerial + 1;
    d.endSerial += n;
    d.count += n;
    d.state = "SIMULATING";
    return { startSerial: first, endSerial: d.endSerial };
  }

  /**
   * 시간 예산 안에서 물리 step 을 진행한다 (§19 SIMULATING). 서버는 이것을 계속 호출한다.
   * 반환: 진행한 step 수와 현재 활성 강체 수.
   */
  processPending(budgetMs = 8): { steps: number; active: number; pending: boolean } {
    const t0 = this.clock();
    let steps = 0;
    this.feed();
    while (this.sim.batchInFlight || this.queued > 0) {
      this.sim.step();
      steps++;
      this.feed();
      if (this.clock() - t0 >= budgetMs) break;
    }
    const spent = this.clock() - t0;
    this.refreshSettled(spent);
    return { steps, active: this.sim.activeCount, pending: this.sim.batchInFlight || this.queued > 0 };
  }

  private refreshSettled(spentMs: number): void {
    for (const d of this.drops.values()) {
      if (d.state === "READY" || d.state === "RELEASED") continue;
      if (d.count === 0) { if (d.state === "CLOSING" || d.state === "FINALIZING") this.markReady(d); continue; }
      let settled = 0;
      for (let id = d.startSerial; id <= d.endSerial; id++) if (id < this.sim.spawned && this.sim.state[id] !== STATE_ACTIVE) settled++;
      d.settled = settled;
      if (spentMs > 0 && (d.state === "SIMULATING" || d.state === "FINALIZING")) d.simulationMs += spentMs;
      if ((d.state === "CLOSING" || d.state === "FINALIZING") && settled === d.count) this.markReady(d);
      else if (d.state === "CLOSING") d.state = "FINALIZING";
    }
  }

  private markReady(d: DropRecord): void {
    d.state = "READY";
    d.readyAt = this.clock();
    d.heightAfter = this.sim.topY;
  }

  /** cutoff: 더 이상 구매를 받지 않는다 (§19 CLOSING). 이미 다 정착했으면 바로 READY. */
  closeDrop(dropId: DropId): DropRecord {
    const d = this.drops.get(dropId);
    if (!d) throw new Error(`unknown drop ${dropId}`);
    if (d.state !== "OPEN" && d.state !== "SIMULATING") return d;
    d.state = "CLOSING";
    d.closedAt = this.clock();
    this.refreshSettled(0);
    return d;
  }

  /** 남은 계산을 끝까지 돌린다 (§19 FINALIZING → READY). 동기, 서버 워커용. */
  finalizeDrop(dropId: DropId, maxSteps = 5_000_000): DropRecord {
    const d = this.closeDrop(dropId);
    if (d.state === "READY" || d.state === "RELEASED") return d;
    d.state = "FINALIZING";
    const t0 = this.clock();
    let steps = 0;
    while ((d.state as DropState) === "FINALIZING" && steps < maxSteps) {
      this.feed();
      this.sim.step();
      steps++;
      this.feed();
      if (steps % 50 === 0 || !this.sim.batchInFlight) this.refreshSettled(0);
    }
    d.simulationMs += this.clock() - t0;
    if ((d.state as DropState) !== "READY") throw new Error(`drop ${dropId} did not settle within ${maxSteps} steps`);
    return d;
  }

  /** 시각 공개 시각 (§19 RELEASED). 계산은 이미 끝나 있어야 한다. */
  releaseDrop(dropId: DropId): DropRecord {
    const d = this.drops.get(dropId);
    if (!d) throw new Error(`unknown drop ${dropId}`);
    if (d.state !== "READY") throw new Error(`drop ${dropId} is ${d.state}, not READY`);
    d.state = "RELEASED";
    d.releasedAt = this.clock();
    return d;
  }

  getDropResult(dropId: DropId): DropResult {
    const d = this.drops.get(dropId);
    if (!d) throw new Error(`unknown drop ${dropId}`);
    if (d.state !== "READY" && d.state !== "RELEASED") throw new Error(`drop ${dropId} is ${d.state}`);
    const finalTransforms = this.sim.snapshot(d.startSerial);
    // snapshot(from) 은 from..spawned 를 주므로 이 Drop 범위만 자른다
    const slice = sliceSet(finalTransforms, 0, d.count);
    slice.startSerial = d.startSerial;
    return { dropId: d.id, total: d.count, startSerial: d.startSerial, endSerial: d.endSerial, finalTransforms: slice, heightBefore: d.heightBefore, heightAfter: d.heightAfter ?? this.sim.topY, simulationMs: d.simulationMs };
  }

  /** 전체 탑 스냅샷 (base + 모든 Drop) */
  towerSnapshot(): TowerData { return this.sim.snapshot(); }

  free(): void { this.sim.free(); }
}

function sliceSet(t: TowerData, from: number, to: number): TowerData {
  return {
    count: to - from, diameter: t.diameter, thickness: t.thickness, unitCm: t.unitCm, startSerial: t.startSerial,
    px: t.px.slice(from, to), py: t.py.slice(from, to), pz: t.pz.slice(from, to),
    qx: t.qx.slice(from, to), qy: t.qy.slice(from, to), qz: t.qz.slice(from, to), qw: t.qw.slice(from, to),
    scale: t.scale.slice(from, to), tscale: t.tscale.slice(from, to),
  };
}
