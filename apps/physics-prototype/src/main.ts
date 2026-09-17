import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import RAPIER from "@dimforge/rapier3d-compat";
import { TowerSim, PRESETS, DEFAULT_CONFIG, decodeTower, computeStackingMetrics, STATE_SURFACE, type SimConfig, type PresetName, type TowerData } from "./sim";
import { TowerRenderer, type Quality, type InstanceSource } from "./render/TowerRenderer";
import { createRng } from "./sim/rng";

const t0 = performance.now();
const params = new URLSearchParams(location.search);
const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
if (params.get("shot") === "1" || params.get("hideui") === "1") document.body.classList.add("shot");

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

const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.05, 200000);
camera.position.set(12, 8, 12);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.target.set(0, 1, 0);

scene.add(new THREE.HemisphereLight("#cfd8ff", "#3a2a18", 0.9));
const sun = new THREE.DirectionalLight("#fff2d6", 2.0);
sun.position.set(30, 60, 20);
sun.castShadow = false;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = sun.shadow.camera.bottom = -20;
sun.shadow.camera.right = sun.shadow.camera.top = 20;
sun.shadow.camera.far = 200;
scene.add(sun);

const ground = new THREE.Mesh(new THREE.CircleGeometry(4000, 64), new THREE.MeshStandardMaterial({ color: "#1b1f2a", roughness: 1 }));
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
type Mode = "physics" | "loaded" | "synthetic";
let mode: Mode = "physics";
let sim: TowerSim | null = null;
let source: InstanceSource | null = null; // 렌더러가 읽는 서버 결과 (물리 모드에서는 sim 자신)
let tower: TowerRenderer | null = null;
let target = 0;
let running = false;
let phase: "idle" | "building" | "done" | "releasing" | "collapsed" | "loaded" | "replaying" = "idle";
let releaseSteps = 0;
let releaseStartMs = 0;
let topY = 0;
let thickness = DEFAULT_CONFIG.thickness;
let unitCm = DEFAULT_CONFIG.unitCm;
let aborted = false;
let lastGoodResult: Record<string, unknown> | null = null;

const ui = {
  target: $<HTMLSelectElement>("target"),
  batch: $<HTMLInputElement>("batch"),
  spawnPerStep: $<HTMLInputElement>("spawnPerStep"),
  stepsPerFrame: $<HTMLInputElement>("stepsPerFrame"),
  preset: $<HTMLSelectElement>("preset"),
  spread: $<HTMLInputElement>("spread"),
  spawnMode: $<HTMLSelectElement>("spawnMode"),
  stick: $<HTMLInputElement>("stick"),
  drape: $<HTMLInputElement>("drape"),
  freeze: $<HTMLInputElement>("freeze"),
  kick: $<HTMLInputElement>("kick"),
  quality: $<HTMLSelectElement>("quality"),
  colorState: $<HTMLInputElement>("colorState"),
  follow: $<HTMLInputElement>("follow"),
  findId: $<HTMLInputElement>("findId"),
  find: $<HTMLButtonElement>("find"),
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

// URL 파라미터 → UI (자동 벤치마크: ?target=100000&auto=1&quality=standard)
for (const [k, v] of params) {
  const el = (ui as Record<string, HTMLElement>)[k];
  if (!el) continue;
  if (el instanceof HTMLInputElement && el.type === "checkbox") el.checked = v !== "0" && v !== "false";
  else if (el instanceof HTMLInputElement || el instanceof HTMLSelectElement) el.value = v;
}
if (params.get("preset")) applyPreset(params.get("preset") as PresetName);

function applyPreset(name: PresetName): void {
  const p = PRESETS[name];
  if (!p) return;
  ui.preset.value = name;
  ui.spread.value = String(p.spawnSpread);
  ui.drape.value = String(p.drape);
}

function readConfig(): Partial<SimConfig> {
  const preset = PRESETS[ui.preset.value as PresetName] ?? {};
  return {
    ...preset,
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
let slowFrames = 0;
const perfMem = (performance as unknown as { memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number } }).memory;

function fmt(n: number, d = 0): string { return n.toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: d }); }

function result(): Record<string, unknown> {
  const frames = samples.slice(-300);
  const avg = (f: (s: Sample) => number): number => frames.length ? frames.reduce((a, s) => a + f(s), 0) / frames.length : 0;
  const sortedFrame = frames.map((s) => s.frameMs).sort((a, b) => a - b);
  const p95 = sortedFrame.length ? sortedFrame[Math.floor((sortedFrame.length - 1) * 0.95)] : 0;
  return {
    mode,
    target,
    instances: source?.spawned ?? 0,
    phase,
    quality: ui.quality.value,
    preset: ui.preset.value,
    config: sim?.cfg ?? null,
    towerHeightM: (topY * unitCm) / 100,
    states: sim ? { active: sim.activeCount, surface: sim.surfaceCount, frozen: sim.frozen, leaks: sim.leakCount } : null,
    fps,
    frameMsAvg: avg((s) => s.frameMs),
    frameMsP95: p95,
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
    screen: [screen.width, screen.height],
    userAgent: navigator.userAgent,
    gpu: gpuName(),
    aborted,
    release: phase === "collapsed" || phase === "releasing" ? { steps: releaseSteps, ms: performance.now() - releaseStartMs } : null,
    replay: replayReport,
    metrics: lastMetrics,
  };
}

function gpuName(): string {
  const gl = renderer.getContext();
  const ext = gl.getExtension("WEBGL_debug_renderer_info");
  return ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : "n/a";
}

function updateStats(): void {
  if (!source) { ui.stats.textContent = "—"; return; }
  const r = result();
  const states = sim ? `ACTIVE ${fmt(sim.activeCount)}  SURFACE ${fmt(sim.surfaceCount)}  FROZEN ${fmt(sim.frozen)}  leaks ${sim.leakCount}\n` : "";
  ui.stats.innerHTML =
    `<b>${phase.toUpperCase()}</b> ${mode}  ${fmt(source.spawned)} / ${fmt(target)}${aborted ? "  <b>ABORTED</b>" : ""}\n` +
    `FPS <b>${fmt(fps)}</b>  frame ${fmt(r.frameMsAvg as number, 1)} ms  p95 ${fmt(r.frameMsP95 as number, 1)} ms\n` +
    (sim ? `physics ${fmt(r.physMsPerStepAvg as number, 2)} ms/step · ${fmt(physTotalSteps)} steps · ${fmt(r.physMsPerFrameAvg as number, 1)} ms/frame\n` : "") +
    states +
    `tower <b>${fmt((topY * unitCm) / 100, 2)} m</b>  (ideal ${fmt((source.spawned * thickness * unitCm) / 100, 2)} m)\n` +
    `draw calls ${fmt(r.drawCalls as number)}  chunks ${r.drawGroups}  tris ${fmt(r.triangles as number)}\n` +
    `heap ${r.jsHeapMB === null ? "n/a" : fmt(r.jsHeapMB as number) + " MB"}  load ${fmt(firstFrameMs)} ms\n` +
    `gpu ${r.gpu}` +
    (replayReport ? `\nreplay max error ${(replayReport.maxPosError as number).toExponential(2)} u / ${(replayReport.maxQuatError as number).toExponential(2)}` : "");
  ui.bigCount.textContent = `${fmt(source.spawned)} 🥞`;
  ui.bigHeight.textContent = `${fmt((topY * unitCm) / 100, 2)} m`;
  ui.bigState.textContent = phase === "building" ? "DROPPING" : phase === "releasing" ? "THE FALL" : phase === "collapsed" ? "SEASON OVER" : phase === "done" ? "TOWER COMPLETE" : phase === "loaded" ? "SERVER TRANSFORMS" : phase === "replaying" ? "DROP REPLAY" : "";
}

// ---------------------------------------------------------------- 렌더러 생성
function makeTower(capacity: number, diameter: number, th: number): void {
  if (tower) tower.dispose(scene);
  const quality = ui.quality.value as Quality;
  tower = new TowerRenderer(scene, capacity, { chunkSize: 10000, diameter, thickness: th, quality, colorByState: ui.colorState.checked });
  renderer.shadowMap.enabled = tower.shadows;
  sun.castShadow = tower.shadows;
}

// ---------------------------------------------------------------- 물리 모드
function reset(): void {
  if (sim) sim.free();
  mode = "physics";
  target = Number(ui.target.value);
  sim = new TowerSim(RAPIER, target, readConfig());
  source = sim;
  thickness = sim.cfg.thickness;
  unitCm = sim.cfg.unitCm;
  makeTower(target, sim.cfg.diameter, sim.cfg.thickness);
  samples.length = 0;
  physTotalMs = 0; physTotalSteps = 0; releaseSteps = 0; topY = 0;
  running = false; aborted = false; replayReport = null; lastMetrics = null;
  phase = "idle";
  ui.start.disabled = false; ui.pause.disabled = true; ui.release.disabled = true;
  controls.target.set(0, 1, 0);
  camera.position.set(12, 8, 12);
  updateStats();
}

function start(): void {
  if (!sim) return;
  if (phase === "idle") phase = "building";
  running = true;
  ui.start.disabled = true; ui.pause.disabled = false;
}
function pause(): void { running = false; ui.start.disabled = false; ui.pause.disabled = true; }
function release(): void {
  if (!sim) return;
  phase = "releasing"; releaseSteps = 0; releaseStartMs = performance.now();
  sim.release(); running = true;
  ui.release.disabled = true; ui.pause.disabled = false;
}

// ---------------------------------------------------------------- 로드 모드 (서버 결과 파일)
let lastMetrics: ReturnType<typeof computeStackingMetrics> | null = null;

function sourceFromData(d: TowerData): InstanceSource {
  return { ...d, state: new Uint8Array(d.count).fill(STATE_SURFACE), spawned: d.count, dirty: Array.from({ length: d.count }, (_, i) => i) };
}

function useSource(src: InstanceSource, d: { diameter: number; thickness: number; unitCm: number }, newMode: Mode): void {
  if (sim) { sim.free(); sim = null; }
  mode = newMode;
  source = src;
  target = src.spawned;
  thickness = d.thickness; unitCm = d.unitCm;
  makeTower(src.spawned, d.diameter, d.thickness);
  const tSync0 = performance.now();
  tower!.sync(src);
  src.dirty = [];
  topY = 0;
  for (let i = 0; i < src.spawned; i++) { const t = src.py[i] + (d.thickness * src.tscale[i]) / 2; if (t > topY) topY = t; }
  console.log(`sync ${src.spawned} instances in ${(performance.now() - tSync0).toFixed(0)} ms`);
  phase = "loaded"; running = false; aborted = false;
  ui.start.disabled = true; ui.pause.disabled = true; ui.release.disabled = true;
  ui.target.value = String(src.spawned);
  updateStats();
}

async function loadTower(url: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`load ${url}: ${res.status}`);
  const d = decodeTower(await res.arrayBuffer());
  useSource(sourceFromData(d), d, "loaded");
  lastMetrics = computeStackingMetrics(d);
}

/** 물리 없이 절차적으로 쌓은 탑 (실제 기기 렌더링 한계 측정용: 500k / 1M) */
function syntheticTower(n: number): void {
  const rng = createRng(42);
  const d = { diameter: DEFAULT_CONFIG.diameter, thickness: DEFAULT_CONFIG.thickness, unitCm: DEFAULT_CONFIG.unitCm };
  const mk = (): Float32Array => new Float32Array(n);
  const t: TowerData = { count: n, ...d, px: mk(), py: mk(), pz: mk(), qx: mk(), qy: mk(), qz: mk(), qw: mk(), scale: mk(), tscale: mk() };
  let x = 0, z = 0, y = 0;
  for (let i = 0; i < n; i++) {
    x = x * 0.9 + (rng() - 0.5) * 0.2; z = z * 0.9 + (rng() - 0.5) * 0.2;
    const ts = 1 + (rng() - 0.5) * 0.2;
    y += d.thickness * ts;
    t.px[i] = x; t.py[i] = y - (d.thickness * ts) / 2; t.pz[i] = z;
    const yaw = rng() * Math.PI * 2, tilt = (rng() - 0.5) * 0.1, ax = rng() * Math.PI * 2;
    // q = yaw ⊗ tilt (근사: 작은 각)
    const sy = Math.sin(yaw / 2), cy = Math.cos(yaw / 2), st = Math.sin(tilt / 2), ct = Math.cos(tilt / 2);
    const tx = Math.cos(ax) * st, tz = Math.sin(ax) * st;
    t.qx[i] = cy * tx + sy * tz; t.qy[i] = sy * ct; t.qz[i] = cy * tz - sy * tx; t.qw[i] = cy * ct;
    t.scale[i] = 1 + (rng() - 0.5) * 0.1; t.tscale[i] = ts;
  }
  useSource(sourceFromData(t), d, "synthetic");
}

// ---------------------------------------------------------------- Find Pancake / 카메라 뷰
let flyTo: { target: THREE.Vector3; pos: THREE.Vector3 } | null = null;

function findPancake(id: number): boolean {
  if (!tower || !source) return false;
  const p = tower.locate(id);
  if (!p) return false;
  tower.highlight(id, source);
  ui.follow.checked = false;
  flyTo = { target: p.clone(), pos: p.clone().add(new THREE.Vector3(2.5, 1.2, 2.5)) };
  return true;
}

function setView(view: string): void {
  ui.follow.checked = false;
  const h = Math.max(topY, 1);
  const r = Math.max(2, h * 0.35);
  const mid = new THREE.Vector3(0, h / 2, 0);
  const top = new THREE.Vector3(0, h, 0);
  // 근접 뷰는 팬케이크 약 30~60 장 구간이 화면에 들어오는 거리 (두께 0.1 → 3~6 units)
  switch (view) {
    case "side": flyTo = { target: mid, pos: mid.clone().add(new THREE.Vector3(5, 0, 0)) }; break;          // 측면, 중간 구간
    case "top": flyTo = { target: top, pos: top.clone().add(new THREE.Vector3(0.01, 4, 0)) }; break;        // 상단 바로 위
    case "iso": flyTo = { target: top.clone().add(new THREE.Vector3(0, -1.5, 0)), pos: top.clone().add(new THREE.Vector3(3.2, 1.8, 3.2)) }; break; // 45도, 최상단
    case "full": flyTo = { target: mid, pos: new THREE.Vector3(r * 1.5, h * 0.7, r * 1.5) }; break;          // 탑 전체
    case "mid": flyTo = { target: mid, pos: mid.clone().add(new THREE.Vector3(4, 1.5, 4)) }; break;          // 중간 확대
    case "peak": flyTo = { target: top, pos: top.clone().add(new THREE.Vector3(3, 1.5, 3)) }; break;         // 최상단
    default:
      if (view.startsWith("find:")) findPancake(Number(view.slice(5)));
  }
  if (flyTo) { controls.target.copy(flyTo.target); camera.position.copy(flyTo.pos); flyTo = null; }
}

// ---------------------------------------------------------------- Drop Replay (§7 분리 검증)
// 서버 transform 을 목표로 마지막 N 장을 클라이언트에서 낙하 연출한 뒤, 정확히 서버 값으로 수렴하는지 확인.
let replayReport: Record<string, unknown> | null = null;
let replay: { ids: number[]; startY: Float32Array; t0: number; durationMs: number; goal: TowerData } | null = null;

function startReplay(count: number, durationMs = 4000): void {
  if (!source || !tower || mode === "physics") return;
  const n = Math.min(count, source.spawned);
  const ids = Array.from({ length: n }, (_, i) => source!.spawned - n + i);
  const goal: TowerData = { count: source.spawned, diameter: 0, thickness, unitCm, px: source.px.slice(), py: source.py.slice(), pz: source.pz.slice(), qx: source.qx.slice(), qy: source.qy.slice(), qz: source.qz.slice(), qw: source.qw.slice(), scale: source.scale, tscale: source.tscale };
  const startY = new Float32Array(n);
  ids.forEach((id, k) => { startY[k] = goal.py[id] + 30 + k * 0.05; });
  replay = { ids, startY, t0: performance.now(), durationMs, goal };
  phase = "replaying";
}

function stepReplay(): void {
  if (!replay || !source || !tower) return;
  const u = Math.min(1, (performance.now() - replay.t0) / replay.durationMs);
  const dirty: number[] = [];
  replay.ids.forEach((id, k) => {
    const g = replay!.goal;
    const local = Math.min(1, Math.max(0, u * 1.3 - k / replay!.ids.length * 0.3)); // 순차 낙하
    const e = 1 - (1 - local) * (1 - local); // ease-out (중력 느낌)
    source!.py[id] = replay!.startY[k] + (g.py[id] - replay!.startY[k]) * e;
    // 회전은 연출 중 살짝 돌다가 서버 값으로
    const wob = (1 - e) * 0.3;
    source!.qx[id] = g.qx[id] + wob * Math.sin(k); source!.qz[id] = g.qz[id] + wob * Math.cos(k);
    const l = Math.hypot(source!.qx[id], g.qy[id], source!.qz[id], g.qw[id]);
    source!.qx[id] /= l; source!.qy[id] = g.qy[id] / l; source!.qz[id] /= l; source!.qw[id] = g.qw[id] / l;
    dirty.push(id);
  });
  if (u >= 1) {
    // 수렴: 클라이언트 값을 서버 값으로 정확히 되돌린다 (연출은 서버 transform 을 절대 바꾸지 않는다)
    for (const id of replay.ids) {
      source.px[id] = replay.goal.px[id]; source.py[id] = replay.goal.py[id]; source.pz[id] = replay.goal.pz[id];
      source.qx[id] = replay.goal.qx[id]; source.qy[id] = replay.goal.qy[id]; source.qz[id] = replay.goal.qz[id]; source.qw[id] = replay.goal.qw[id];
    }
    source.dirty = dirty; tower.sync(source); source.dirty = [];
    // 검증: 렌더 인스턴스 행렬 ↔ 서버 값
    const p = new THREE.Vector3(), q = new THREE.Quaternion();
    let maxPos = 0, maxQuat = 0;
    for (const id of replay.ids) {
      tower.readInstance(id, p, q);
      maxPos = Math.max(maxPos, Math.hypot(p.x - replay.goal.px[id], p.y - replay.goal.py[id], p.z - replay.goal.pz[id]));
      const dq = Math.min(Math.hypot(q.x - replay.goal.qx[id], q.y - replay.goal.qy[id], q.z - replay.goal.qz[id], q.w - replay.goal.qw[id]), Math.hypot(q.x + replay.goal.qx[id], q.y + replay.goal.qy[id], q.z + replay.goal.qz[id], q.w + replay.goal.qw[id]));
      maxQuat = Math.max(maxQuat, dq);
    }
    replayReport = { animated: replay.ids.length, durationMs: replay.durationMs, maxPosError: maxPos, maxQuatError: maxQuat, converged: maxPos < 1e-4 && maxQuat < 1e-4 };
    replay = null; phase = "loaded";
    updateStats();
    return;
  }
  source.dirty = dirty; tower.sync(source); source.dirty = [];
}

// ---------------------------------------------------------------- 내보내기 / 버튼
function exportJson(): void {
  const blob = new Blob([JSON.stringify(result(), null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `phase0.5-${mode}-${target}-${ui.quality.value}-${Date.now()}.json`;
  a.click();
}

ui.start.onclick = start;
ui.pause.onclick = pause;
ui.release.onclick = release;
ui.reset.onclick = reset;
ui.export.onclick = exportJson;
ui.find.onclick = () => { if (!findPancake(Number(ui.findId.value))) alert("no such pancake"); };
ui.preset.onchange = () => { applyPreset(ui.preset.value as PresetName); if (phase === "idle") reset(); };
ui.quality.onchange = () => { if (phase === "idle") reset(); else if (source) { makeTower(source.spawned, DEFAULT_CONFIG.diameter, thickness); tower!.syncAll(source); } };
ui.colorState.onchange = () => { if (tower && source) { (tower as unknown as { opts: { colorByState: boolean } }).opts.colorByState = ui.colorState.checked; tower.syncAll(source); } };

// ---------------------------------------------------------------- 루프
const camTarget = new THREE.Vector3();
function frame(): void {
  const now = performance.now();
  const frameMs = now - lastFrame;
  lastFrame = now;
  physMsThisFrame = 0; stepsThisFrame = 0;

  if (sim && tower && running && !aborted) {
    const stepsPerFrame = Math.max(1, Number(ui.stepsPerFrame.value));
    const dirtyAll: number[] = [];
    for (let i = 0; i < stepsPerFrame; i++) {
      if (phase === "building") {
        if (!sim.batchInFlight && sim.spawned < target) sim.queueBatch(Math.min(sim.cfg.batchSize, target - sim.spawned));
        if (!sim.batchInFlight && sim.spawned >= target) { phase = "done"; running = false; ui.pause.disabled = true; ui.release.disabled = false; lastMetrics = sim.metrics(); break; }
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
    topY = sim.topY;
  }
  if (replay) stepReplay();

  if (flyTo) {
    controls.target.lerp(flyTo.target, 0.1);
    camera.position.lerp(flyTo.pos, 0.1);
    if (camera.position.distanceTo(flyTo.pos) < 0.01) flyTo = null;
  } else if (source && ui.follow.checked && phase !== "idle" && mode === "physics") {
    camTarget.set(0, topY + 1, 0);
    controls.target.lerp(camTarget, 0.08);
    const dist = Math.max(8, Math.min(60, 6 + topY * 0.08));
    const dir = camera.position.clone().sub(controls.target);
    if (dir.length() > dist * 1.6 || dir.length() < dist * 0.6) { dir.setLength(dist); camera.position.copy(controls.target).add(dir); }
  }
  controls.update();
  renderer.render(scene, camera);

  if (!firstFrameMs) firstFrameMs = performance.now() - t0;
  samples.push({ frameMs, physMs: physMsThisFrame, steps: stepsThisFrame });
  if (samples.length > 600) samples.shift();
  fpsAccum += frameMs; fpsCount++;
  if (now - fpsTimer > 500) { fps = 1000 / (fpsAccum / fpsCount); fpsAccum = 0; fpsCount = 0; fpsTimer = now; updateStats(); }

  // 기기 보호 (Phase 0.5 §8): 프레임이 계속 3초를 넘거나 heap 이 한계의 85% 를 넘으면 중단하고 마지막 정상 결과를 남긴다.
  if (!aborted && running) {
    slowFrames = frameMs > 3000 ? slowFrames + 1 : 0;
    const heapBad = perfMem ? perfMem.usedJSHeapSize > perfMem.jsHeapSizeLimit * 0.85 : false;
    if (slowFrames >= 5 || heapBad) { aborted = true; running = false; phase = "done"; console.warn("benchmark aborted for device safety", { slowFrames, heapBad }); }
    else if (fpsCount === 0) lastGoodResult = result();
  }
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------- 시작
declare global { interface Window { __RESULT?: Record<string, unknown>; __READY?: boolean; __sim?: TowerSim | null; __find?: (id: number) => boolean; __view?: (v: string) => void; __replay?: (n: number) => void } }
async function setup(): Promise<void> {
  await RAPIER.init();
  const load = params.get("load");
  const synthetic = params.get("synthetic");
  if (load) await loadTower(load);
  else if (synthetic) syntheticTower(Number(synthetic));
  else reset();
  window.__sim = sim;
  window.__find = findPancake;
  window.__view = setView;
  window.__replay = (n: number) => startReplay(n);
  requestAnimationFrame(frame);

  const view = params.get("view");
  if (view) requestAnimationFrame(() => setView(view));

  if (params.get("replay")) {
    startReplay(Number(params.get("replay")));
  }
  const finish = (): void => { window.__RESULT = aborted && lastGoodResult ? { ...lastGoodResult, aborted: true } : result(); window.__READY = true; console.log("PHASE05_RESULT " + JSON.stringify(window.__RESULT)); };
  if (params.get("auto") === "1") {
    if (mode === "physics") start();
    const tick = setInterval(() => {
      if (phase === "done" && params.get("release") === "1" && !aborted) { release(); return; }
      if (phase === "done" || phase === "collapsed" || ((phase === "loaded") && !replay)) {
        clearInterval(tick);
        // 정상 상태에서 5초간 프레임을 재고 기록
        setTimeout(finish, Number(params.get("settle") ?? 5000));
      }
    }, 500);
  } else if (params.get("shot") === "1") {
    setTimeout(() => { window.__READY = true; }, 1500);
  }
}
setup().catch((e) => { console.error(e); ui.stats.textContent = String(e); });
