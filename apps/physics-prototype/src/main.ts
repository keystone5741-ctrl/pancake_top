import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import RAPIER from "@dimforge/rapier3d-compat";
import { TowerSim, type SimConfig } from "./sim";
import { TowerRenderer, type Quality } from "./render/TowerRenderer";

const t0 = performance.now();
const params = new URLSearchParams(location.search);
const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

// ---------------------------------------------------------------- Three.js
const app = $("app");
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = false;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
app.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color("#0d0f14");
scene.fog = new THREE.Fog("#0d0f14", 200, 2500);

const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.05, 100000);
camera.position.set(12, 8, 12);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.target.set(0, 1, 0);

const hemi = new THREE.HemisphereLight("#cfd8ff", "#3a2a18", 0.9);
scene.add(hemi);
const sun = new THREE.DirectionalLight("#fff2d6", 2.0);
sun.position.set(30, 60, 20);
sun.castShadow = false;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = sun.shadow.camera.bottom = -20;
sun.shadow.camera.right = sun.shadow.camera.top = 20;
sun.shadow.camera.far = 200;
scene.add(sun);

const ground = new THREE.Mesh(
  new THREE.CircleGeometry(4000, 64),
  new THREE.MeshStandardMaterial({ color: "#1b1f2a", roughness: 1 }),
);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);
const grid = new THREE.GridHelper(200, 200, "#2a2e3a", "#1f2330");
(grid.material as THREE.Material).transparent = true;
(grid.material as THREE.Material).opacity = 0.5;
scene.add(grid);

addEventListener("resize", () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// ---------------------------------------------------------------- 상태
let sim: TowerSim | null = null;
let tower: TowerRenderer | null = null;
let target = 0;
let running = false;
let phase: "idle" | "building" | "done" | "releasing" | "collapsed" = "idle";
let releaseSteps = 0;
let releaseStartMs = 0;

const ui = {
  target: $<HTMLSelectElement>("target"),
  batch: $<HTMLInputElement>("batch"),
  spawnPerStep: $<HTMLInputElement>("spawnPerStep"),
  stepsPerFrame: $<HTMLInputElement>("stepsPerFrame"),
  spread: $<HTMLInputElement>("spread"),
  spawnMode: $<HTMLSelectElement>("spawnMode"),
  stick: $<HTMLInputElement>("stick"),
  drape: $<HTMLInputElement>("drape"),
  freeze: $<HTMLInputElement>("freeze"),
  kick: $<HTMLInputElement>("kick"),
  quality: $<HTMLSelectElement>("quality"),
  colorState: $<HTMLInputElement>("colorState"),
  follow: $<HTMLInputElement>("follow"),
  start: $<HTMLButtonElement>("start"),
  pause: $<HTMLButtonElement>("pause"),
  release: $<HTMLButtonElement>("release"),
  reset: $<HTMLButtonElement>("reset"),
  export: $<HTMLButtonElement>("export"),
  stats: $("stats"),
  bigCount: $("bigCount"),
  bigHeight: $("bigHeight"),
  bigState: $("bigState"),
};

// URL 파라미터 → UI (자동 벤치마크용: ?target=10000&auto=1&quality=performance)
for (const [k, v] of params) {
  const el = (ui as Record<string, HTMLElement>)[k];
  if (!el) continue;
  if (el instanceof HTMLInputElement && el.type === "checkbox") el.checked = v !== "0" && v !== "false";
  else if (el instanceof HTMLInputElement || el instanceof HTMLSelectElement) el.value = v;
}

function readConfig(): Partial<SimConfig> {
  return {
    batchSize: Number(ui.batch.value),
    spawnPerStep: Number(ui.spawnPerStep.value),
    spawnSpread: Number(ui.spread.value),
    spawnMode: ui.spawnMode.value as "axis" | "top",
    stickOnContact: ui.stick.checked,
    drape: Number(ui.drape.value),
    freezeEnabled: ui.freeze.checked,
    releaseKick: Number(ui.kick.value),
  };
}

// ---------------------------------------------------------------- 측정
interface Sample { frameMs: number; physMs: number; steps: number }
const samples: Sample[] = [];
let lastFrame = performance.now();
let fpsAccum = 0, fpsCount = 0, fps = 0, fpsTimer = performance.now();
let physMsThisFrame = 0, stepsThisFrame = 0;
let physTotalMs = 0, physTotalSteps = 0;
let firstFrameMs = 0;
const perfMem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;

function fmt(n: number, d = 0): string { return n.toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: d }); }

function result(): Record<string, unknown> {
  const frames = samples.slice(-300);
  const avg = (f: (s: Sample) => number): number => frames.length ? frames.reduce((a, s) => a + f(s), 0) / frames.length : 0;
  return {
    target,
    spawned: sim?.spawned ?? 0,
    phase,
    quality: ui.quality.value,
    config: sim?.cfg ?? null,
    towerHeightM: sim?.towerHeightMeters ?? 0,
    states: sim ? { active: sim.activeCount, surface: sim.surfaceCount, frozen: sim.frozen, leaks: sim.leakCount } : null,
    fps,
    frameMsAvg: avg((s) => s.frameMs),
    physMsPerFrameAvg: avg((s) => s.physMs),
    physMsPerStepAvg: physTotalSteps ? physTotalMs / physTotalSteps : 0,
    physSteps: physTotalSteps,
    drawCalls: renderer.info.render.calls,
    triangles: renderer.info.render.triangles,
    drawGroups: tower?.drawGroups ?? 0,
    jsHeapMB: perfMem ? perfMem.usedJSHeapSize / 1048576 : null,
    loadMs: firstFrameMs,
    devicePixelRatio,
    viewport: [innerWidth, innerHeight],
    userAgent: navigator.userAgent,
    gpu: gpuName(),
    release: phase === "collapsed" || phase === "releasing" ? { steps: releaseSteps, ms: performance.now() - releaseStartMs } : null,
  };
}

function gpuName(): string {
  const gl = renderer.getContext();
  const ext = gl.getExtension("WEBGL_debug_renderer_info");
  return ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : "n/a";
}

function updateStats(): void {
  if (!sim) { ui.stats.textContent = "—"; return; }
  const r = result();
  ui.stats.innerHTML =
    `<b>${phase.toUpperCase()}</b>  ${fmt(sim.spawned)} / ${fmt(target)}\n` +
    `FPS <b>${fmt(fps)}</b>  frame ${fmt(r.frameMsAvg as number, 1)} ms  physics ${fmt(r.physMsPerFrameAvg as number, 1)} ms/frame\n` +
    `physics ${fmt(r.physMsPerStepAvg as number, 2)} ms/step · ${fmt(physTotalSteps)} steps\n` +
    `ACTIVE ${fmt(sim.activeCount)}  SURFACE ${fmt(sim.surfaceCount)}  FROZEN ${fmt(sim.frozen)}  leaks ${sim.leakCount}\n` +
    `tower <b>${fmt(sim.towerHeightMeters, 2)} m</b>  (ideal ${fmt((sim.spawned * sim.cfg.thickness * sim.cfg.unitCm) / 100, 2)} m)\n` +
    `draw calls ${fmt(r.drawCalls as number)}  chunks ${r.drawGroups}  tris ${fmt(r.triangles as number)}\n` +
    `heap ${r.jsHeapMB === null ? "n/a" : fmt(r.jsHeapMB as number) + " MB"}  load ${fmt(firstFrameMs)} ms\n` +
    `gpu ${r.gpu}`;
  ui.bigCount.textContent = `${fmt(sim.spawned)} 🥞`;
  ui.bigHeight.textContent = `${fmt(sim.towerHeightMeters, 2)} m`;
  ui.bigState.textContent = phase === "building" ? "DROPPING" : phase === "releasing" ? "THE FALL" : phase === "collapsed" ? "SEASON OVER" : phase === "done" ? "TOWER COMPLETE" : "";
}

// ---------------------------------------------------------------- 제어
async function setup(): Promise<void> {
  await RAPIER.init();
  reset();
}

function reset(): void {
  if (tower) tower.dispose(scene);
  if (sim) sim.free();
  target = Number(ui.target.value);
  sim = new TowerSim(RAPIER, target, readConfig());
  const quality = ui.quality.value as Quality;
  tower = new TowerRenderer(scene, target, {
    chunkSize: 10000,
    diameter: sim.cfg.diameter,
    thickness: sim.cfg.thickness,
    quality,
    colorByState: ui.colorState.checked,
  });
  renderer.shadowMap.enabled = tower.shadows;
  sun.castShadow = tower.shadows;
  samples.length = 0;
  physTotalMs = 0; physTotalSteps = 0; releaseSteps = 0;
  running = false;
  phase = "idle";
  ui.start.disabled = false;
  ui.pause.disabled = true;
  ui.release.disabled = true;
  controls.target.set(0, 1, 0);
  camera.position.set(12, 8, 12);
  updateStats();
}

function start(): void {
  if (!sim) return;
  if (phase === "idle") phase = "building";
  running = true;
  ui.start.disabled = true;
  ui.pause.disabled = false;
}

function pause(): void {
  running = false;
  ui.start.disabled = false;
  ui.pause.disabled = true;
}

function release(): void {
  if (!sim) return;
  phase = "releasing";
  releaseSteps = 0;
  releaseStartMs = performance.now();
  sim.release();
  running = true;
  ui.release.disabled = true;
  ui.pause.disabled = false;
}

function exportJson(): void {
  const blob = new Blob([JSON.stringify(result(), null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `phase0-${target}-${ui.quality.value}-${Date.now()}.json`;
  a.click();
}

ui.start.onclick = start;
ui.pause.onclick = pause;
ui.release.onclick = release;
ui.reset.onclick = reset;
ui.export.onclick = exportJson;
ui.quality.onchange = () => { if (phase === "idle") reset(); };
ui.colorState.onchange = () => { if (tower && sim) { (tower as unknown as { opts: { colorByState: boolean } }).opts.colorByState = ui.colorState.checked; tower.syncAll(sim); } };

// ---------------------------------------------------------------- 루프
const camTarget = new THREE.Vector3();
function frame(): void {
  const now = performance.now();
  const frameMs = now - lastFrame;
  lastFrame = now;
  physMsThisFrame = 0; stepsThisFrame = 0;

  if (sim && tower && running) {
    const stepsPerFrame = Math.max(1, Number(ui.stepsPerFrame.value));
    const dirtyAll: number[] = [];
    for (let i = 0; i < stepsPerFrame; i++) {
      if (phase === "building") {
        if (!sim.batchInFlight && sim.spawned < target) sim.queueBatch(Math.min(sim.cfg.batchSize, target - sim.spawned));
        if (!sim.batchInFlight && sim.spawned >= target) { phase = "done"; running = false; ui.pause.disabled = true; ui.release.disabled = false; break; }
      } else if (phase === "releasing") {
        if (!sim.batchInFlight) { phase = "collapsed"; running = false; ui.pause.disabled = true; break; }
        releaseSteps++;
      }
      const s = sim.step();
      physMsThisFrame += s.stepMs; stepsThisFrame++;
      for (const id of sim.dirty) dirtyAll.push(id);
    }
    physTotalMs += physMsThisFrame; physTotalSteps += stepsThisFrame;
    sim.dirty = dirtyAll;
    tower.sync(sim);
    sim.dirty = [];
  }

  if (sim && ui.follow.checked && phase !== "idle") {
    camTarget.set(0, sim.topY + 1, 0);
    controls.target.lerp(camTarget, 0.08);
    const dist = Math.max(8, Math.min(60, 6 + sim.topY * 0.08));
    const dir = camera.position.clone().sub(controls.target);
    if (dir.length() > dist * 1.6 || dir.length() < dist * 0.6) {
      dir.setLength(dist);
      camera.position.copy(controls.target).add(dir);
    }
  }
  controls.update();
  renderer.render(scene, camera);

  if (!firstFrameMs) firstFrameMs = performance.now() - t0;
  samples.push({ frameMs, physMs: physMsThisFrame, steps: stepsThisFrame });
  if (samples.length > 600) samples.shift();
  fpsAccum += frameMs; fpsCount++;
  if (now - fpsTimer > 500) { fps = 1000 / (fpsAccum / fpsCount); fpsAccum = 0; fpsCount = 0; fpsTimer = now; updateStats(); }
  requestAnimationFrame(frame);
}

// 자동 벤치마크 모드: 완료 시 window.__RESULT 에 기록 (Playwright 로 수집)
declare global { interface Window { __RESULT?: Record<string, unknown>; __sim?: TowerSim | null } }
setup().then(() => {
  window.__sim = sim;
  requestAnimationFrame(frame);
  if (params.get("auto") === "1") {
    start();
    const tick = setInterval(() => {
      if (phase === "done" && params.get("release") === "1") { release(); return; }
      if (phase === "done" || phase === "collapsed") {
        clearInterval(tick);
        setTimeout(() => { window.__RESULT = result(); console.log("PHASE0_RESULT " + JSON.stringify(window.__RESULT)); }, 1500);
      }
    }, 500);
  }
});
