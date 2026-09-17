/**
 * Phase 0 헤드리스 벤치마크 (Node).
 *
 *   pnpm bench                         # 100, 1k, 10k
 *   pnpm bench -- --targets 100,1000,10000,100000 --release
 *   pnpm bench -- --targets 10000 --spread 0.3 --no-freeze
 *
 * 서버 Physics Worker 관점의 지표(시뮬레이션 시간, step 당 비용, 탑 높이, 정확성)를 측정한다.
 * 렌더링 지표(FPS, GPU)는 브라우저 앱(`pnpm dev`)에서 측정한다.
 */
import RAPIER from "@dimforge/rapier3d-compat";
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { TowerSim, DEFAULT_CONFIG, PRESETS, encodeTower, formatMetrics, type SimConfig, type PresetName, type StackingMetrics } from "../src/sim";

/** 1 unit = 1 m 프리셋: 실제 치수 + 실제 중력, Rapier lengthUnit 으로 허용오차 스케일링 */
const METERS: Partial<SimConfig> = {
  unitCm: 100, diameter: 0.1, thickness: 0.01, edgeRadius: 0.003, gravity: -9.81,
  spawnSpread: 0.015, spawnClearance: 0.3, settleLinVel: 0.02, settleAngVel: 0.6,
  freezeDepth: 0.06, stickMaxSpeed: 0.3, lengthUnit: 0.1,
};

interface Args {
  targets: number[];
  release: boolean;
  slab: number;
  releaseMaxSteps: number;
  out?: string;
  dump?: string;
  preset?: PresetName;
  cfg: Partial<SimConfig>;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { targets: [100, 1000, 10000], release: false, slab: 0, releaseMaxSteps: 0, cfg: {} };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    switch (k) {
      case "--targets": a.targets = v.split(",").map(Number); i++; break;
      case "--release": a.release = true; break;
      case "--slab": a.slab = Number(v); i++; break;
      case "--release-max-steps": a.releaseMaxSteps = Number(v); i++; break;
      case "--out": a.out = v; i++; break;
      case "--dump": a.dump = v; i++; break;
      case "--preset": a.preset = v as PresetName; Object.assign(a.cfg, PRESETS[v as PresetName]); i++; break;
      case "--batch": a.cfg.batchSize = Number(v); i++; break;
      case "--spawn-per-step": a.cfg.spawnPerStep = Number(v); i++; break;
      case "--spread": a.cfg.spawnSpread = Number(v); i++; break;
      case "--tilt": a.cfg.spawnTilt = Number(v); i++; break;
      case "--friction": a.cfg.friction = Number(v); i++; break;
      case "--freeze-depth": a.cfg.freezeDepth = Number(v); i++; break;
      case "--no-freeze": a.cfg.freezeEnabled = false; break;
      case "--no-ccd": a.cfg.ccd = false; break;
      case "--spawn-mode": a.cfg.spawnMode = v as "axis" | "top"; i++; break;
      case "--no-stick": a.cfg.stickOnContact = false; break;
      case "--stick-speed": a.cfg.stickMaxSpeed = Number(v); i++; break;
      case "--edge": a.cfg.edgeRadius = Number(v); i++; break;
      case "--iters": a.cfg.solverIterations = Number(v); i++; break;
      case "--contact-hz": a.cfg.contactHz = Number(v); i++; break;
      case "--kick": a.cfg.releaseKick = Number(v); i++; break;
      case "--drape": a.cfg.drape = Number(v); i++; break;
      case "--meters": Object.assign(a.cfg, METERS); break;
      case "--max-steps": a.cfg.maxStepsPerBatch = Number(v); i++; break;
      case "--dt": a.cfg.dt = 1 / Number(v); i++; break;
      case "--seed": a.cfg.seed = Number(v); i++; break;
      case "--": break;
      default: throw new Error(`unknown arg ${k}`);
    }
  }
  return a;
}

interface RunResult {
  target: number;
  preset?: string;
  config: SimConfig;
  metrics?: StackingMetrics;
  build: {
    totalMs: number;
    steps: number;
    msPerStep: { avg: number; p50: number; p95: number; max: number };
    msPerPancake: number;
    simSeconds: number;
    realtimeRatio: number;
    batches: number;
    maxActive: number;
    maxSurface: number;
    finalSurface: number;
    finalFrozen: number;
    leaks: number;
    towerHeightM: number;
    idealHeightM: number;
    heightEfficiency: number;
    footprintRadiusM: number;
    rssMB: number;
    heapMB: number;
  };
  release?: {
    mode: string;
    released: number;
    settledAfter: number;
    totalMs: number;
    steps: number;
    msPerStep: number;
    maxActive: number;
    leaks: number;
    heightAfterM: number;
    footprintAfterM: number;
    timedOut: boolean;
  };
}

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

function runBuild(sim: TowerSim, target: number, log: (s: string) => void): RunResult["build"] {
  const stepTimes: number[] = [];
  let maxActive = 0;
  let maxSurface = 0;
  let batches = 0;
  const t0 = performance.now();
  let lastLog = t0;

  while (sim.spawned < target || sim.batchInFlight) {
    if (!sim.batchInFlight && sim.spawned < target) {
      sim.queueBatch(Math.min(sim.cfg.batchSize, target - sim.spawned));
      batches++;
    }
    const s = sim.step();
    stepTimes.push(s.stepMs);
    if (s.active > maxActive) maxActive = s.active;
    if (s.surface > maxSurface) maxSurface = s.surface;
    const t = performance.now();
    if (t - lastLog > 5000) {
      lastLog = t;
      log(
        `  … ${sim.spawned}/${target} spawned, step ${s.step}, active ${s.active}, surface ${s.surface}, frozen ${s.frozen}, top ${sim.towerHeightMeters.toFixed(2)} m, ${((t - t0) / 1000).toFixed(0)}s`,
      );
    }
  }
  const totalMs = performance.now() - t0;
  const sorted = [...stepTimes].sort((a, b) => a - b);
  const idealHeightM = (target * sim.cfg.thickness * sim.cfg.unitCm) / 100;
  const mem = process.memoryUsage();
  return {
    totalMs,
    steps: stepTimes.length,
    msPerStep: {
      avg: stepTimes.reduce((a, b) => a + b, 0) / stepTimes.length,
      p50: pct(sorted, 0.5),
      p95: pct(sorted, 0.95),
      max: sorted[sorted.length - 1],
    },
    msPerPancake: totalMs / target,
    simSeconds: stepTimes.length * sim.cfg.dt,
    realtimeRatio: (stepTimes.length * sim.cfg.dt * 1000) / totalMs,
    batches,
    maxActive,
    maxSurface,
    finalSurface: sim.surfaceCount,
    finalFrozen: sim.frozen,
    leaks: sim.leakCount,
    towerHeightM: sim.towerHeightMeters,
    idealHeightM,
    heightEfficiency: sim.towerHeightMeters / idealHeightM,
    footprintRadiusM: (sim.footprintRadius() * sim.cfg.unitCm) / 100,
    rssMB: mem.rss / 1048576,
    heapMB: mem.heapUsed / 1048576,
  };
}

function runRelease(sim: TowerSim, slab: number, maxSteps: number, log: (s: string) => void): NonNullable<RunResult["release"]> {
  const budgetMs = 10 * 60 * 1000;
  const t0 = performance.now();
  let steps = 0;
  let maxActive = 0;
  let released = 0;
  let timedOut = false;
  const leaksBefore = sim.leakCount;

  const settleAll = (): void => {
    while (sim.batchInFlight) {
      const s = sim.step();
      steps++;
      if (s.active > maxActive) maxActive = s.active;
      if (performance.now() - t0 > budgetMs || (maxSteps > 0 && steps >= maxSteps)) {
        timedOut = true;
        break;
      }
    }
  };

  if (slab > 0) {
    const ids = sim.settledIdsTopDown();
    for (let i = 0; i < ids.length && !timedOut; i += slab) {
      released += sim.release(ids.slice(i, i + slab));
      settleAll();
      log(`  … slab ${i / slab + 1}/${Math.ceil(ids.length / slab)}, ${((performance.now() - t0) / 1000).toFixed(0)}s`);
    }
  } else {
    released = sim.release();
    settleAll();
  }
  const totalMs = performance.now() - t0;
  return {
    mode: slab > 0 ? `slab ${slab}` : "all at once",
    settledAfter: sim.spawned - sim.activeCount,
    released,
    totalMs,
    steps,
    msPerStep: steps ? totalMs / steps : 0,
    maxActive,
    leaks: sim.leakCount - leaksBefore,
    heightAfterM: sim.towerHeightMeters,
    footprintAfterM: (sim.footprintRadius() * sim.cfg.unitCm) / 100,
    timedOut,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  await RAPIER.init();
  const log = (s: string): void => console.log(s);
  const results: RunResult[] = [];

  console.log(`Rapier ${RAPIER.version()} · Node ${process.version}`);
  console.log(`config: ${JSON.stringify({ ...DEFAULT_CONFIG, ...args.cfg })}\n`);

  for (const target of args.targets) {
    console.log(`=== ${target.toLocaleString()} pancakes ===`);
    const sim = new TowerSim(RAPIER, target, args.cfg);
    const build = runBuild(sim, target, log);
    const r: RunResult = { target, preset: args.preset, config: sim.cfg, build, metrics: sim.metrics() };
    console.log(formatMetrics(r.metrics!).split("\n").map((l) => "  " + l).join("\n"));
    if (args.dump) {
      const name = args.dump.replace("{target}", String(target)).replace("{preset}", args.preset ?? "default");
      mkdirSync(resolve(name, ".."), { recursive: true });
      writeFileSync(name, Buffer.from(encodeTower(sim.snapshot())));
      console.log(`  dumped ${name}`);
    }
    console.log(
      `  build: ${(build.totalMs / 1000).toFixed(2)}s, ${build.steps} steps, ${build.msPerStep.avg.toFixed(2)} ms/step (p95 ${build.msPerStep.p95.toFixed(2)}, max ${build.msPerStep.max.toFixed(1)}), ${build.msPerPancake.toFixed(3)} ms/pancake, ${build.realtimeRatio.toFixed(1)}x realtime`,
    );
    console.log(
      `  tower: ${build.towerHeightM.toFixed(2)} m (ideal ${build.idealHeightM.toFixed(2)} m, efficiency ${(build.heightEfficiency * 100).toFixed(1)}%), footprint r=${build.footprintRadiusM.toFixed(2)} m`,
    );
    console.log(
      `  states: maxActive ${build.maxActive}, maxSurface ${build.maxSurface}, final surface ${build.finalSurface} / frozen ${build.finalFrozen}, leaks ${build.leaks}, rss ${build.rssMB.toFixed(0)} MB`,
    );
    if (args.release) {
      const rel = runRelease(sim, args.slab, args.releaseMaxSteps, log);
      r.release = rel;
      console.log(
        `  release (${rel.mode}): ${rel.released} released, settled again ${rel.settledAfter}, ${(rel.totalMs / 1000).toFixed(2)}s, ${rel.steps} steps, ${rel.msPerStep.toFixed(2)} ms/step, maxActive ${rel.maxActive}, leaks ${rel.leaks}, height after ${rel.heightAfterM.toFixed(2)} m, footprint r=${rel.footprintAfterM.toFixed(2)} m${rel.timedOut ? " (TIMED OUT)" : ""}`,
      );
    }
    results.push(r);
    sim.free();
    console.log("");
  }

  if (args.out) {
    const p = resolve(args.out);
    mkdirSync(resolve(p, ".."), { recursive: true });
    writeFileSync(p, JSON.stringify({ generatedAt: new Date().toISOString(), node: process.version, rapier: RAPIER.version(), results }, null, 2));
    console.log(`wrote ${p}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
