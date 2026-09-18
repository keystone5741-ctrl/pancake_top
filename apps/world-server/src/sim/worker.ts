/**
 * Simulation worker (child process, Phase 2 §21~§22). Rapier 는 여기서만 돈다.
 * 상태: INIT 로 받은 surface 위에 TowerSim 을 만들고 SIMULATE_APPEND 마다 이어서 쌓는다.
 * 죽으면 main 이 마지막 커밋된 surface 로 새 worker 를 INIT 한다.
 */
import RAPIER from "@dimforge/rapier3d-compat";
import { PRESETS, TopNSurfaceProvider, TowerSim, computeStackingMetrics, decodeTower, encodeTower, type SimConfig, type TowerData } from "pancake-physics";
import type { FromWorker, ToWorker } from "./protocol";

let sim: TowerSim | null = null;
let sliceSize = 512;

const send = (m: FromWorker): void => { process.send?.(m); };

/** y 기준 상위 k 개 인덱스 (min-heap, O(n log k)) — 전체 정렬(O(n log n))은 100k 이상에서 job 마다 수십 ms 를 먹었다 (Phase 3A §6). */
function topKIndices(py: Float32Array, n: number, k: number): number[] {
  if (k >= n) return Array.from({ length: n }, (_, i) => i);
  const heap: number[] = []; // 인덱스, py 기준 min-heap
  const less = (a: number, b: number): boolean => py[a] < py[b];
  const up = (i: number): void => { while (i > 0) { const p = (i - 1) >> 1; if (less(heap[i], heap[p])) { [heap[i], heap[p]] = [heap[p], heap[i]]; i = p; } else break; } };
  const down = (i: number): void => { for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < heap.length && less(heap[l], heap[m])) m = l; if (r < heap.length && less(heap[r], heap[m])) m = r; if (m === i) break; [heap[i], heap[m]] = [heap[m], heap[i]]; i = m; } };
  for (let i = 0; i < n; i++) { if (heap.length < k) { heap.push(i); up(heap.length - 1); } else if (py[i] > py[heap[0]]) { heap[0] = i; down(0); } }
  return heap.sort((a, b) => a - b);
}
function surfaceSlice(t: TowerData, k: number): TowerData {
  // 상위 k 장 (y 기준). 높이맵·콜라이더의 근거. 새 worker 의 base 가 된다.
  const n = t.count;
  const order = topKIndices(t.py, n, Math.min(k, n));
  const m = order.length;
  const pick = (arr: Float32Array): Float32Array => { const o = new Float32Array(m); for (let i = 0; i < m; i++) o[i] = arr[order[i]]; return o; };
  return { count: m, diameter: t.diameter, thickness: t.thickness, unitCm: t.unitCm, px: pick(t.px), py: pick(t.py), pz: pick(t.pz), qx: pick(t.qx), qy: pick(t.qy), qz: pick(t.qz), qw: pick(t.qw), scale: pick(t.scale), tscale: pick(t.tscale) };
}
const toBytes = (t: TowerData): Uint8Array => new Uint8Array(encodeTower(t));
const fromBytes = (b: Uint8Array): TowerData => decodeTower(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);

async function handle(msg: ToWorker): Promise<void> {
  switch (msg.type) {
    case "PING": send({ type: "PONG" }); return;
    case "DEV_CRASH": process.exit(137);
    case "INIT": {
      await RAPIER.init();
      sim?.free();
      sliceSize = msg.surfaceSliceSize;
      const cfg: Partial<SimConfig> = { ...PRESETS.natural, ...(msg.config as Partial<SimConfig>) };
      const surface = msg.surface ? fromBytes(msg.surface) : null;
      sim = new TowerSim(RAPIER, (surface?.count ?? 0) + msg.capacity, cfg);
      if (surface && surface.count > 0) {
        const ids = new TopNSurfaceProvider(msg.surfaceTopN).getSurfaceColliders(surface);
        sim.loadBase(surface, ids);
      }
      send({ type: "READY", spawned: sim.spawned, heightUnits: sim.topY });
      return;
    }
    case "SIMULATE_APPEND": {
      if (!sim) { send({ type: "ERROR", jobId: msg.jobId, message: "not initialised" }); return; }
      const t0 = performance.now();
      const from = sim.spawned;
      let queued = 0, maxActive = 0, steps = 0;
      const batch = sim.cfg.batchSize;
      // seed 는 job 마다 rng 를 다시 잡지 않는다(연속성). 결정성은 (snapshot, seed, 순서) 로 확보하며 seed 는 INIT config 로 전달된다.
      while (queued < msg.count || sim.batchInFlight) {
        if (!sim.batchInFlight && queued < msg.count) { const n = Math.min(batch, msg.count - queued); if (sim.queueBatch(n) !== n) { send({ type: "ERROR", jobId: msg.jobId, message: "capacity exceeded" }); return; } queued += n; }
        const s = sim.step(); steps++;
        if (s.active > maxActive) maxActive = s.active;
      }
      const all = sim.snapshot();
      const fresh = sim.snapshot(from);
      // 모양 지표는 이번 job 분량 + 표면 조각만 (전체 탑 O(n) 계측은 100k 에서 job 당 60 ms 였다)
      const m = computeStackingMetrics(fresh.count >= 2 ? fresh : surfaceSlice(all, sliceSize));
      const wallMs = performance.now() - t0;
      send({
        type: "RESULT", jobId: msg.jobId, finalTransforms: toBytes(fresh), surfaceAfter: toBytes(surfaceSlice(all, sliceSize)), heightUnits: sim.topY, spawned: sim.spawned,
        metrics: { steps, wallMs, msPerPancake: wallMs / Math.max(1, msg.count), maxActive, surfaceCount: sim.surfaceCount, penetrationMax: m.penetration.max, penetrationP95: m.penetration.p95, tiltMedian: m.tilt.median, leaks: sim.leakCount },
      });
      return;
    }
    case "SNAPSHOT": {
      if (!sim) { send({ type: "ERROR", message: "not initialised" }); return; }
      send({ type: "SNAPSHOT_RESULT", surface: toBytes(surfaceSlice(sim.snapshot(), sliceSize)), heightUnits: sim.topY, spawned: sim.spawned });
      return;
    }
  }
}

process.on("message", (msg: ToWorker) => { handle(msg).catch((e) => send({ type: "ERROR", message: String(e) })); });
process.on("disconnect", () => process.exit(0));
