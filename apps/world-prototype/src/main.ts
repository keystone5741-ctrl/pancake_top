import * as THREE from "three";
import { formatHeight } from "pancake-core";
import RAPIER from "@dimforge/rapier3d-compat";
import type { PancakeTransformSet } from "pancake-core";
import { DEFAULT_TOWER_CONFIG, MemoryChunkSource, Tower, generateSyntheticTower } from "tower-engine";
import { ChunkRenderer, DropReplay, QualityManager, type FarViewMode, type QualityPresetName } from "pancake-renderer";
import { ContinuousDropSimulator, PRESETS } from "pancake-physics";
import { CameraRig, altitudeStops } from "pancake-navigation";
import { buildScaleModel, renderScaleSvg } from "./heightScale";
import { connectRealtime, fetchManifest, makeRemoteSource, type ServerManifest } from "./remote";
import type { UrlChunkSource } from "tower-engine";

const params = new URLSearchParams(location.search);
const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
if (params.get("shot") === "1") document.body.classList.add("shot");
const t0 = performance.now();

// ---------------------------------------------------------------- Quality
const quality = new QualityManager((params.get("quality") as QualityPresetName) || "standard");
$<HTMLSelectElement>("quality").value = quality.current.name;

// ---------------------------------------------------------------- Three.js
const renderer = new THREE.WebGLRenderer({ antialias: quality.current.antialias, powerPreference: "high-performance" });
renderer.setPixelRatio(Math.min(devicePixelRatio, quality.current.pixelRatioCap));
renderer.setSize(innerWidth, innerHeight);
$("app").appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color("#0d0f14");
const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.05, 2_000_000);
camera.position.set(12, 8, 12);
scene.add(new THREE.HemisphereLight("#cfd8ff", "#3a2a18", 0.9));
const sun = new THREE.DirectionalLight("#fff2d6", 2.0);
sun.position.set(30, 60, 20);
scene.add(sun);
const ground = new THREE.Mesh(new THREE.CircleGeometry(20000, 64), new THREE.MeshStandardMaterial({ color: "#1b1f2a", roughness: 1 }));
ground.rotation.x = -Math.PI / 2;
scene.add(ground);
const grid = new THREE.GridHelper(200, 200, "#2a2e3a", "#1f2330");
(grid.material as THREE.Material).transparent = true; (grid.material as THREE.Material).opacity = 0.5;
scene.add(grid);
addEventListener("resize", () => { camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight); });

// ---------------------------------------------------------------- World
let tower: Tower;
let chunks: ChunkRenderer;
let rig: CameraRig;
let source: MemoryChunkSource;
/** 물리 base 로 쓰는 현재 탑 전체 (서버 결과와 같은 데이터) */
let currentSet: PancakeTransformSet;
const cfg = { ...DEFAULT_TOWER_CONFIG, chunkSize: Number(params.get("chunkSize") ?? DEFAULT_TOWER_CONFIG.chunkSize) };

function buildWorld(src: MemoryChunkSource | UrlChunkSource): void {
  if (chunks) { scene.remove(chunks.group); chunks.dispose(); }
  if (rig) rig.dispose();
  source = src as MemoryChunkSource;
  tower = new Tower(src);
  chunks = new ChunkRenderer(tower, quality);
  chunks.silhouette.mode = ($<HTMLSelectElement>("far").value as FarViewMode);
  scene.add(chunks.group);
  rig = new CameraRig(camera, renderer.domElement, tower, chunks, { reducedMotion: params.get("reducedMotion") === "1" || undefined });
  buildAltitudeNav();
  (window as unknown as { __world: unknown }).__world = { tower, chunks, rig, quality };
}

function loadSynthetic(n: number): void {
  const t = performance.now();
  const set = generateSyntheticTower(n, cfg, 42);
  currentSet = set;
  buildWorld(new MemoryChunkSource(set, cfg));
  console.log(`synthetic ${n}: generate+chunk ${(performance.now() - t).toFixed(0)} ms, ${tower.chunkCount} chunks, height ${formatHeight(tower.heightMeters)}`);
  $<HTMLSelectElement>("count").value = String(n);
}

// ---------------------------------------------------------------- Remote server mode (Phase 2 §41)
const sourceMode = params.get("source") === "server" ? "server" : "local";
const serverUrl = (params.get("server") ?? "http://localhost:8787").replace(/\/$/, "");
let remote: UrlChunkSource | null = null;
let remoteManifest: ServerManifest | null = null;
let remoteState: Record<string, unknown> = {};
let wsStatus = "off";
let manifestFetches = 0;

async function loadFromServer(): Promise<void> {
  const t = performance.now();
  remoteManifest = await fetchManifest(serverUrl); manifestFetches++;
  remote = makeRemoteSource(serverUrl, remoteManifest);
  buildWorld(remote);
  console.log(`server world: version ${remoteManifest.version}, ${remoteManifest.totalPancakes} pancakes, ${remoteManifest.chunks.length} chunks, height ${formatHeight(remoteManifest.heightMeters)} (${(performance.now() - t).toFixed(0)} ms, no chunk downloaded yet)`);
  connectRealtime(serverUrl, {
    onStatus: (st) => { wsStatus = st; },
    onSnapshot: (snap) => { remoteState = snap; if (typeof snap.version === "number" && remoteManifest && snap.version > remoteManifest.version) void refreshManifest(); },
    onEvent: (e) => {
      if (e.type === "drop.queueUpdated") remoteState = { ...remoteState, queueSize: e.queueSize, nextDropAt: remoteState.nextDropAt };
      if (e.type === "drop.closing") remoteState = { ...remoteState, dropStatus: "CLOSING" };
      if (e.type === "drop.ready") remoteState = { ...remoteState, dropStatus: "READY" };
      if (e.type === "drop.delayed") remoteState = { ...remoteState, dropStatus: "DELAYED" };
      if (e.type === "drop.released") void onDropReleased(e as { startSerial: number | null; endSerial: number | null; dropId: string });
    },
  });
}

/** manifest 갱신: checksum 이 바뀐 chunk 만 다시 받는다 (§18, §42). */
async function refreshManifest(): Promise<number[]> {
  if (!remote) return [];
  remoteManifest = await fetchManifest(serverUrl); manifestFetches++;
  const changed = remote.updateManifest((await import("./remote")).toTowerManifest(remoteManifest));
  tower.refresh(changed);
  chunks.invalidateChunks(changed);
  buildAltitudeNav();
  return changed;
}

/** drop.released: 새 manifest → 바뀐 chunk 로드 → 공개된 범위를 Replay (history playback, §30) */
async function onDropReleased(e: { startSerial: number | null; endSerial: number | null; dropId: string }): Promise<void> {
  $("dropStatus").textContent = `${e.dropId} released — loading`;
  await refreshManifest();
  if (e.startSerial === null || e.endSerial === null) return;
  const s = e.startSerial - 1, t = e.endSerial - 1;
  for (let cid = tower.chunkIdOf(s); cid <= tower.chunkIdOf(t); cid++) await chunks.ensureChunkHigh(cid);
  lastDrop = { startSerial: s, endSerial: t, simulationMs: 0, total: t - s + 1, heightBeforeM: 0, heightAfterM: tower.heightMeters };
  rig.top();
  replayFrames = [];
  replay = new DropReplay(tower, chunks, s, t, { durationMs: 4000, dropHeight: 30, stagger: 0.3, seed: s });
  remoteState = { ...remoteState, dropStatus: "RELEASED" };
}

// ---------------------------------------------------------------- Altitude navigator (Phase 1 §14)
function buildAltitudeNav(): void {
  const box = $("altitude");
  const { stops, position } = altitudeStops(tower.heightMeters);
  const W = 120, H = box.clientHeight || 400, pad = 14;
  const y = (m: number): number => H - pad - position(m) * (H - 2 * pad);
  const items = stops.map((s) => {
    const py = y(s.meters);
    const isTower = s.label.startsWith("TOWER");
    return `<line x1="30" y1="${py}" x2="${isTower ? 46 : 38}" y2="${py}" class="${isTower ? "tower" : "tick"}"/><text x="50" y="${py + 3}" ${isTower ? 'fill="#f6c453" font-weight="700"' : ""}>${s.label}</text><rect class="hit" x="0" y="${py - 7}" width="${W}" height="14" data-m="${s.meters}"/>`;
  }).join("");
  box.innerHTML = `<svg viewBox="0 0 ${W} ${H}"><line x1="34" y1="${y(0)}" x2="34" y2="${y(stops[stops.length - 1].meters)}" class="tick"/>${items}</svg>`;
  box.querySelectorAll<SVGRectElement>(".hit").forEach((r) => { r.onclick = () => rig.goToAltitude(Number(r.dataset.m)); });
}

// ---------------------------------------------------------------- Height mode (Phase 1 §17)
function showHeightMode(): void {
  const model = buildScaleModel(tower.heightMeters); // Tower.heightMeters 가 유일한 source
  $("heightSvg").innerHTML = renderScaleSvg(model, innerWidth, innerHeight);
  $("heightMode").style.display = "block";
  rig.heightMode();
}
$("heightClose").onclick = () => { $("heightMode").style.display = "none"; };

// ---------------------------------------------------------------- Measurement
const frameTimes: number[] = [];
let last = performance.now();
let fps = 0, fpsAcc = 0, fpsN = 0, fpsTimer = last;
let firstFrameMs = 0;
function p(sorted: number[], q: number): number { return sorted.length ? sorted[Math.floor((sorted.length - 1) * q)] : 0; }

function snapshot(): Record<string, unknown> {
  const sorted = [...frameTimes].sort((a, b) => a - b);
  const s = chunks.stats;
  return {
    count: tower.count, chunks: tower.chunkCount, loadedChunks: tower.loadedChunkCount, gpuChunks: s.gpuChunks, visibleChunks: s.visibleChunks,
    renderedInstances: s.renderedInstances, lodCounts: s.lodCounts, estimatedGpuInstanceMB: s.estimatedGpuInstanceBytes / 1048576,
    towerHeightM: tower.heightMeters, cameraAltitudeM: rig.altitudeMeters, quality: quality.current.name, farView: chunks.silhouette.mode,
    fps, frameMsP95: p(sorted, 0.95), frameMsP99: p(sorted, 0.99), drawCalls: renderer.info.render.calls, triangles: renderer.info.render.triangles,
    lodTriangles: chunks.lodTriangles, loadMs: firstFrameMs, jsHeapMB: (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? null,
    gpu: gpuName(), userAgent: navigator.userAgent, viewport: [innerWidth, innerHeight], dpr: renderer.getPixelRatio(),
    selected: chunks.highlight.current ? { id: chunks.highlight.current.pancakeId, chunkId: chunks.highlight.current.chunkId, instanceIndex: chunks.highlight.current.instanceIndex } : null,
    source: sourceMode,
    remote: remote ? { server: serverUrl, worldVersion: remoteManifest?.version, manifestFetches, chunkFetches: remote.stats.fetches, bytesDownloaded: remote.stats.bytes, cacheHits: remote.stats.cacheHits, checksumFailures: remote.stats.checksumFailures, cachedChunks: remote.cachedChunkIds.length, wsStatus } : null,
    drop: lastDrop,
    replay: replayReport ? { ...replayReport, framesDuringReplay: replayFrames.length, fpsDuringReplay: replayFrames.length ? 1000 / (replayFrames.reduce((a, b) => a + b, 0) / replayFrames.length) : 0 } : null,
  };
}
function gpuName(): string { const gl = renderer.getContext(); const ext = gl.getExtension("WEBGL_debug_renderer_info"); return ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : "n/a"; }

function updateHud(): void {
  const s = snapshot();
  $("hudCount").textContent = tower.count.toLocaleString();
  $("hudHeight").textContent = formatHeight(tower.heightMeters);
  $("hudVisible").textContent = chunks.stats.renderedInstances.toLocaleString();
  $("hudChunks").textContent = `${chunks.stats.gpuChunks} / ${tower.chunkCount}`;
  $("hudFps").textContent = fps.toFixed(0);
  $("hudQuality").textContent = quality.current.name;
  if (sourceMode === "server") {
    const next = typeof remoteState.nextDropAt === "string" ? new Date(remoteState.nextDropAt as string).getTime() - Date.now() : NaN;
    const cd = Number.isFinite(next) ? `${Math.max(0, Math.floor(next / 60000))}:${String(Math.max(0, Math.floor((next % 60000) / 1000))).padStart(2, "0")}` : "—";
    const q = (remoteState.currentDrop as { queueSize?: number } | undefined)?.queueSize ?? remoteState.queueSize ?? 0;
    $("hudNext").textContent = `${cd}  ·  ${Number(q).toLocaleString()} 🥞 waiting  ·  ${String(remoteState.dropStatus ?? (remoteState.currentDrop as { status?: string } | undefined)?.status ?? "")}`;
    $("hudNextRow").style.display = "contents";
  }
  $("debug").textContent =
    `fps ${fps.toFixed(1)}  p95 ${(s.frameMsP95 as number).toFixed(1)} ms  draw ${s.drawCalls}  tris ${(s.triangles as number).toLocaleString()}\n` +
    `pancakes ${tower.count.toLocaleString()}  chunks loaded ${tower.loadedChunkCount}/${tower.chunkCount}  gpu ${chunks.stats.gpuChunks}  visible ${chunks.stats.visibleChunks}\n` +
    `rendered ${chunks.stats.renderedInstances.toLocaleString()}  LOD0 ${chunks.stats.lodCounts[0].toLocaleString()}  LOD1 ${chunks.stats.lodCounts[1].toLocaleString()}  LOD2 ${chunks.stats.lodCounts[2].toLocaleString()}\n` +
    `gpu instance mem ≈ ${(s.estimatedGpuInstanceMB as number).toFixed(1)} MB  tri/lod ${chunks.lodTriangles.join("/")}\n` +
    `camera alt ${formatHeight(rig.altitudeMeters)}  tower ${formatHeight(tower.heightMeters)}  nearest px ${chunks.stats.projectedPxAtNearest.toFixed(2)}  mode ${rig.mode}\n` +
    `far view ${chunks.silhouette.mode}  quality ${quality.current.name}  rec ${quality.recommendPreset({ gpuRenderer: gpuName(), mobile: /Mobi|Android|iPhone/.test(navigator.userAgent) })}` +
    (remote ? `\nserver ${serverUrl}  ws ${wsStatus}  world v${remoteManifest?.version}  manifests ${manifestFetches}  chunks fetched ${remote.stats.fetches} (${(remote.stats.bytes / 1048576).toFixed(2)} MB)  cache hits ${remote.stats.cacheHits}  checksum fails ${remote.stats.checksumFailures}` : "");
}

// ---------------------------------------------------------------- Controls
$<HTMLSelectElement>("quality").onchange = (e) => quality.setPreset((e.target as HTMLSelectElement).value as QualityPresetName);
$<HTMLSelectElement>("sourceSel").value = sourceMode;
$<HTMLSelectElement>("sourceSel").onchange = (e) => { const v = (e.target as HTMLSelectElement).value; const u = new URL(location.href); if (v === "server") u.searchParams.set("source", "server"); else u.searchParams.delete("source"); location.href = u.toString(); };
$<HTMLSelectElement>("count").onchange = (e) => loadSynthetic(Number((e.target as HTMLSelectElement).value));
$<HTMLSelectElement>("far").onchange = (e) => { chunks.silhouette.mode = (e.target as HTMLSelectElement).value as FarViewMode; };
$("find").onclick = () => { void findPancake(Number($<HTMLInputElement>("findId").value)); };
$("full").onclick = () => rig.fullTower();
$("top").onclick = () => rig.top();
$("height").onclick = showHeightMode;

/** UI 는 #1 부터, 엔진은 0 부터 */
async function findPancake(displayId: number): Promise<void> {
  const cid = tower.chunkIdOf(displayId - 1);
  if (tower.state(cid) === "UNLOADED") $("dropStatus").textContent = `Loading pancake #${displayId.toLocaleString()}…`;
  const r = await rig.findPancake(displayId - 1);
  if (r) $("dropStatus").textContent = `#${displayId.toLocaleString()} → chunk ${r.result.chunkId} / instance ${r.result.instanceIndex} (${r.lookupMs.toFixed(1)} ms)`;
  if (!r) { $("dropStatus").textContent = `no pancake #${displayId}`; return; }
  console.log(`find #${displayId}: chunk ${r.result.chunkId} instance ${r.result.instanceIndex} lookup ${r.lookupMs.toFixed(2)} ms`);
}

// ---------------------------------------------------------------- Continuous Drop + Replay (Phase 1 §18~§26)
let replay: DropReplay | null = null;
let lastDrop: { startSerial: number; endSerial: number; simulationMs: number; total: number; heightBeforeM: number; heightAfterM: number } | null = null;
let replayFrames: number[] = [];
let replayReport: Record<string, unknown> | null = null;
let rapierReady: Promise<void> | null = null;

/** 브라우저 안에서 "서버" 역할: 현재 탑 위에 N 장을 연속 시뮬레이션으로 계산해 탑에 붙인다. frozen 탑은 물리에 넣지 않는다. */
async function simulateDrop(n: number): Promise<void> {
  rapierReady ??= RAPIER.init();
  await rapierReady;
  const status = $("dropStatus");
  const t0 = performance.now();
  const c = new ContinuousDropSimulator(RAPIER, { capacity: currentSet.count + n, base: currentSet, config: { ...PRESETS.natural, seed: 777 + tower.count } });
  const drop = c.createDrop();
  status.textContent = `drop ${drop.id}: base loaded (${(performance.now() - t0).toFixed(0)} ms, ${c.surfaceColliderCount} surface colliders)`;
  // 구매가 100장씩 도착한다고 가정: 즉시 큐에 넣고 프레임마다 8 ms 씩 계산
  let sent = 0;
  await new Promise<void>((resolve) => {
    const tick = (): void => {
      if (sent < n) { c.enqueuePancakes(drop.id, Math.min(100, n - sent)); sent += 100; }
      const r = c.processPending(8);
      status.textContent = `drop ${drop.id}: ${Math.min(sent, n)}/${n} enqueued, settled ${c.get(drop.id)!.settled}, active ${r.active}, ${((performance.now() - t0) / 1000).toFixed(1)} s`;
      if (sent >= n && !r.pending) resolve(); else requestAnimationFrame(tick);
    };
    tick();
  });
  c.closeDrop(drop.id);
  c.finalizeDrop(drop.id);
  const res = c.getDropResult(drop.id);
  c.free();
  // 탑에 붙인다 (서버 → 클라이언트 chunk 갱신)
  const changed = source.append(res.finalTransforms);
  tower.refresh(changed);
  chunks.invalidateChunks(changed);
  currentSet = { ...currentSet, count: currentSet.count + res.total };
  // 물리 base 갱신: 전체 배열 재구성 (프로토타입: O(n))
  const merged = generateMerged(currentSet.count);
  currentSet = merged;
  buildAltitudeNav();
  lastDrop = { startSerial: res.startSerial, endSerial: res.endSerial, simulationMs: res.simulationMs, total: res.total, heightBeforeM: (res.heightBefore * cfg.unitCm) / 100, heightAfterM: (res.heightAfter * cfg.unitCm) / 100 };
  status.textContent = `drop ${drop.id} READY: ${res.total} pancakes, sim ${(res.simulationMs / 1000).toFixed(2)} s, height ${formatHeight(lastDrop.heightBeforeM)} → ${formatHeight(lastDrop.heightAfterM)}`;
  $<HTMLButtonElement>("replay").disabled = false;
}

/** 현재 chunk 들에서 전체 transform set 재구성 */
function generateMerged(n: number): PancakeTransformSet {
  const out = { ...currentSet, count: n, px: new Float32Array(n), py: new Float32Array(n), pz: new Float32Array(n), qx: new Float32Array(n), qy: new Float32Array(n), qz: new Float32Array(n), qw: new Float32Array(n), scale: new Float32Array(n), tscale: new Float32Array(n) };
  for (const h of tower.headers) {
    const c = tower.loadChunkSync(h.id)!;
    for (let i = 0; i < c.count; i++) {
      const s = h.startSerial + i, o = i * 9;
      out.px[s] = c.transforms[o]; out.py[s] = c.transforms[o + 1]; out.pz[s] = c.transforms[o + 2];
      out.qx[s] = c.transforms[o + 3]; out.qy[s] = c.transforms[o + 4]; out.qz[s] = c.transforms[o + 5]; out.qw[s] = c.transforms[o + 6];
      out.scale[s] = c.transforms[o + 7]; out.tscale[s] = c.transforms[o + 8];
    }
  }
  return out;
}

async function startReplay(): Promise<void> {
  if (!lastDrop) return;
  for (let cid = tower.chunkIdOf(lastDrop.startSerial); cid <= tower.chunkIdOf(lastDrop.endSerial); cid++) await chunks.ensureChunkHigh(cid);
  rig.top();
  replayFrames = [];
  replay = new DropReplay(tower, chunks, lastDrop.startSerial, lastDrop.endSerial, { durationMs: 4000, dropHeight: 30, stagger: 0.3, seed: lastDrop.startSerial });
}

$("drop").onclick = () => { if (sourceMode === "server") { $("dropStatus").textContent = "server mode: drops come from the server"; return; } void simulateDrop(Number($<HTMLSelectElement>("dropN").value)); };
$("replay").onclick = () => { void startReplay(); };

// ---------------------------------------------------------------- Loop
function frame(): void {
  const now = performance.now();
  const dt = now - last; last = now;
  rig.update();
  if (replay) { replayFrames.push(dt); if (replay.update(now)) { const r = replay.result!; $("dropStatus").textContent = `replay ${r.animated} pancakes: converged ${r.converged} (pos err ${r.maxPosError}, quat err ${r.maxQuatError.toExponential(1)})`; replayReport = { ...r }; replay = null; } }
  chunks.update(camera, innerHeight * renderer.getPixelRatio(), dt);
  renderer.render(scene, camera);
  if (!firstFrameMs) firstFrameMs = performance.now() - t0;
  frameTimes.push(dt); if (frameTimes.length > 600) frameTimes.shift();
  fpsAcc += dt; fpsN++;
  if (now - fpsTimer > 500) { fps = 1000 / (fpsAcc / fpsN); fpsAcc = 0; fpsN = 0; fpsTimer = now; quality.updateMetrics({ fps, frameMsP95: p([...frameTimes].sort((a, b) => a - b), 0.95), drawCalls: renderer.info.render.calls }); updateHud(); }
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------- Start
declare global { interface Window { __RESULT?: Record<string, unknown>; __READY?: boolean; __snapshot?: () => Record<string, unknown>; __find?: (id: number) => Promise<void> } }
async function start(): Promise<void> {
  if (sourceMode === "server") await loadFromServer(); else loadSynthetic(Number(params.get("synthetic") ?? 100000));
  if (params.get("far")) { $<HTMLSelectElement>("far").value = params.get("far")!; chunks.silhouette.mode = params.get("far") as FarViewMode; }
  window.__snapshot = snapshot;
  window.__find = findPancake;
  requestAnimationFrame(frame);
  const view = params.get("view");
  requestAnimationFrame(() => {
    if (view === "full") rig.fullTower();
    else if (view === "top") rig.top();
    else if (view === "height") showHeightMode();
    else if (view?.startsWith("alt:")) rig.goToAltitude(Number(view.slice(4)));
    else if (view?.startsWith("far:")) { const d = Number(view.slice(4)); const h = tower.height; rig.flyTo([d * 0.7071, h * 0.5 + d * 0.15, d * 0.7071], [0, h * 0.5, 0], "explore"); }
    else rig.top();
  });
  if (params.get("find")) setTimeout(() => void findPancake(Number(params.get("find"))), 300);
  if (params.get("drop")) {
    await simulateDrop(Number(params.get("drop")));
    await startReplay();
    await new Promise<void>((r) => { const w = (): void => { if (!replay) r(); else setTimeout(w, 100); }; w(); });
  }
  if (params.get("auto") === "1") {
    setTimeout(() => { window.__RESULT = snapshot(); window.__READY = true; console.log("WORLD_RESULT " + JSON.stringify(window.__RESULT)); }, Number(params.get("settle") ?? 5000));
  } else if (params.get("shot") === "1") {
    setTimeout(() => { window.__READY = true; }, Number(params.get("settle") ?? 4000));
  }
}
void start();
