/**
 * Rapier 0.20 `unreachable` 패닉 최소 재현 (Phase 2 §53). 제품 코드와 무관한 순수 Rapier 버전(pure)과,
 * 제품 TowerSim 의 freezeMode:"remove" 버전(towersim) 두 가지.
 *
 *   tsx remove-frozen-repro.ts --mode pure|towersim|rebuild [--batch 20] [--seed 1] [--count 3000]
 *
 * 패턴: 얇은 round-cylinder 들을 batch 장씩 탑 위에 떨어뜨린다. 고정 body 와 접촉하면(syrup) 그 자리에서 Fixed 로 바꾸고,
 * 표면보다 freezeDepth 아래 묻힌 Fixed body 는 removeRigidBody 로 제거한다. 다음 batch 는 모든 body 가 멈춘 뒤 넣는다.
 * 종료 코드: 0 = 완주, 2 = wasm 패닉(RuntimeError: unreachable), 1 = 다른 오류.
 */
import RAPIER from "@dimforge/rapier3d-compat";

const argv = process.argv.slice(2);
const opt = (k: string, d: string): string => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const mode = opt("--mode", "pure");
const batch = Number(opt("--batch", "20"));
const seed = Number(opt("--seed", "1"));
const count = Number(opt("--count", "3000"));
const freezeDepth = Number(opt("--freeze-depth", "0.6"));
const doRemove = opt("--remove", "1") === "1"; // 0 = 제거 대신 그냥 둔다 (대조군)
const doConvert = opt("--convert", "1") === "1"; // 0 = Fixed 로 바꾸지 않고 잠든 dynamic 을 그대로 제거 (변형)
const settleSteps = Number(opt("--settle-steps", "0")); // 제거 전에 추가로 돌리는 step 수 (변형)
const progress = { spawned: 0, removed: 0, steps: 0, batches: 0 };

function rng(s: number): () => number { let a = s >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

async function pure(): Promise<void> {
  await RAPIER.init();
  const R = RAPIER;
  const world = new R.World({ x: 0, y: -98.1, z: 0 });
  world.integrationParameters.dt = 1 / 60;
  world.integrationParameters.contact_natural_frequency = 30;
  world.integrationParameters.lengthUnit = 1;
  const ground = world.createRigidBody(R.RigidBodyDesc.fixed().setTranslation(0, -5, 0));
  world.createCollider(R.ColliderDesc.cuboid(5000, 5, 5000).setFriction(0.8), ground);
  const r = rng(seed);
  const halfH = 0.05, radius = 0.5, edge = 0.03;
  const dynamic = new Set<RAPIER.RigidBody>();
  const fixed: RAPIER.RigidBody[] = [];
  const eq = new R.EventQueue(true);
  let spawned = 0, removed = 0, steps = 0, top = 0;
  while (spawned < count) {
    // batch 개 스폰 (약간 흩어서, 탑 위 3 unit)
    const n = Math.min(batch, count - spawned);
    for (let i = 0; i < n; i++) {
      const desc = R.RigidBodyDesc.dynamic().setTranslation((r() - 0.5) * 0.2, top + 3 + i * 0.4, (r() - 0.5) * 0.2).setLinearDamping(2).setAngularDamping(1).setCcdEnabled(true);
      const b = world.createRigidBody(desc);
      world.createCollider(R.ColliderDesc.roundCylinder(halfH - edge, radius - edge, edge).setFriction(0.8).setRestitution(0).setDensity(1).setActiveEvents(R.ActiveEvents.COLLISION_EVENTS), b);
      dynamic.add(b); spawned++;
    }
    // 모두 멈출 때까지 (syrup: 고정체와 접촉 즉시 Fixed)
    let guard = 0;
    while (dynamic.size > 0 && guard++ < 4000) {
      world.step(eq);
      steps++;
      const stick: RAPIER.RigidBody[] = [];
      eq.drainCollisionEvents((h1: number, h2: number, started: boolean) => {
        if (!started) return;
        const c1 = world.getCollider(h1), c2 = world.getCollider(h2);
        const b1 = c1?.parent(), b2 = c2?.parent();
        if (!b1 || !b2) return;
        if (b1.isDynamic() && b2.isFixed()) stick.push(b1);
        else if (b2.isDynamic() && b1.isFixed()) stick.push(b2);
      });
      for (const b of stick) {
        if (!dynamic.has(b)) continue;
        if (doConvert) b.setBodyType(R.RigidBodyType.Fixed, false); else b.sleep();
        dynamic.delete(b); fixed.push(b);
        top = Math.max(top, b.translation().y);
      }
      for (const b of dynamic) if (b.isSleeping()) { if (doConvert) b.setBodyType(R.RigidBodyType.Fixed, false); dynamic.delete(b); fixed.push(b); top = Math.max(top, b.translation().y); }
    }
    // 묻힌 Fixed body 제거 (제품의 FROZEN)
    for (let k = 0; k < settleSteps; k++) { world.step(eq); steps++; }
    for (let i = fixed.length - 1; i >= 0; i--) {
      const b = fixed[i];
      if (top - b.translation().y >= freezeDepth) { if (doRemove) world.removeRigidBody(b); fixed.splice(i, 1); removed++; }
    }
    progress.spawned = spawned; progress.removed = removed; progress.steps = steps; progress.batches++;
  }
  console.log(`pure: ok spawned ${spawned} removed ${removed} (remove=${doRemove}) steps ${steps} bodies ${world.bodies.len()} top ${top.toFixed(2)}`);
}

/** 초소형: 팬케이크 2~3장. 1장이 바닥에 닿아 Fixed 가 되고, 2장이 그 위에 닿아 Fixed 가 된 뒤 1장을 제거한다. */
async function minimal(): Promise<void> {
  await RAPIER.init();
  const R = RAPIER;
  const world = new R.World({ x: 0, y: -98.1, z: 0 });
  world.integrationParameters.dt = 1 / 60;
  const ground = world.createRigidBody(R.RigidBodyDesc.fixed().setTranslation(0, -5, 0));
  world.createCollider(R.ColliderDesc.cuboid(50, 5, 50), ground);
  const mk = (y: number): RAPIER.RigidBody => { const b = world.createRigidBody(R.RigidBodyDesc.dynamic().setTranslation(0, y, 0).setLinearDamping(2).setCcdEnabled(true)); world.createCollider(R.ColliderDesc.roundCylinder(0.02, 0.47, 0.03).setFriction(0.8).setDensity(1), b); return b; };
  const n = Number(opt("--n", "3"));
  const bodies: RAPIER.RigidBody[] = [];
  for (let i = 0; i < n; i++) {
    const b = mk(1 + i * 0.5); bodies.push(b);
    let guard = 0; while (!b.isSleeping() && guard++ < 2000) world.step();
    if (doConvert) b.setBodyType(R.RigidBodyType.Fixed, false);
    for (let k = 0; k < settleSteps; k++) world.step();
    progress.spawned = i + 1; progress.steps += guard;
  }
  // 맨 아래(묻힌) body 제거 → 패닉?
  world.removeRigidBody(bodies[0]); progress.removed = 1;
  world.step();
  console.log(`minimal: ok n ${n} convert=${doConvert} removed bottom body, bodies ${world.bodies.len()}`);
}

async function towersim(freezeMode: "remove" | "rebuild"): Promise<void> {
  const { TowerSim, PRESETS } = await import("pancake-physics");
  await RAPIER.init();
  const sim = new TowerSim(RAPIER, count, { ...PRESETS.natural, seed, freezeMode, batchSize: batch });
  while (sim.spawned < count || sim.batchInFlight) {
    if (!sim.batchInFlight && sim.spawned < count) sim.queueBatch(Math.min(batch, count - sim.spawned));
    sim.step();
  }
  console.log(`${freezeMode}: ok spawned ${sim.spawned} height ${sim.towerHeightMeters.toFixed(2)} m steps ${sim.steps} frozen ${sim.frozen}`);
}

try {
  if (mode === "pure") await pure();
  else if (mode === "minimal") await minimal();
  else if (mode === "towersim") await towersim("remove");
  else if (mode === "rebuild") await towersim("rebuild");
  else throw new Error(`unknown mode ${mode}`);
  process.exit(0);
} catch (e) {
  const msg = String((e as Error)?.message ?? e);
  const panic = (e as Error)?.constructor?.name === "RuntimeError" || /unreachable/.test(msg);
  console.error(`${mode}: ${panic ? "WASM PANIC" : "ERROR"}: ${msg} (after ${progress.batches} batches, spawned ${progress.spawned}, removed ${progress.removed}, steps ${progress.steps})`);
  process.exit(panic ? 2 : 1);
}
