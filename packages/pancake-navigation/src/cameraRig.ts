import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { metersToWorldUnits, worldUnitsToMeters } from "pancake-core";
import type { ChunkRenderer } from "pancake-renderer";
import type { FindResult, Tower } from "tower-engine";
import { altitudeViewpoint, findViewpoint, flightAt, flightDuration, fullTowerViewpoint, topViewpoint, type FlightPlan, type Vec3 } from "./flight";

export type CameraMode = "explore" | "fullTower" | "top" | "findPancake" | "heightMode";

export interface CameraRigOptions {
  reducedMotion?: boolean;
}

/**
 * 카메라 내비게이션 (Phase 1 §11~§14). 모드 전환은 항상 부드러운 비행이며 teleport 하지 않는다.
 * prefers-reduced-motion 이면 즉시 이동.
 */
export class CameraRig {
  readonly controls: OrbitControls;
  mode: CameraMode = "explore";
  private flight: { plan: FlightPlan; start: number } | null = null;
  private readonly reducedMotion: boolean;
  private lastFlyMs = 0;
  onModeChange?: (m: CameraMode) => void;

  constructor(readonly camera: THREE.PerspectiveCamera, domElement: HTMLElement, readonly tower: Tower, readonly renderer: ChunkRenderer, opts: CameraRigOptions = {}) {
    this.controls = new OrbitControls(camera, domElement);
    this.controls.enableDamping = true;
    this.controls.minDistance = tower.config.diameter * 0.6;
    this.controls.maxDistance = 1e6;
    this.reducedMotion = opts.reducedMotion ?? (typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches);
    // 사용자가 조작하면 explore 로
    this.controls.addEventListener("start", () => { this.flight = null; this.setMode("explore"); });
  }

  get flying(): boolean { return this.flight !== null; }
  /** 비행 중이면 도착 지점 (스트리밍이 "지나가는 chunk" 대신 "도착해서 볼 chunk" 를 받게 한다) */
  get flightDestination(): { pos: Vec3; target: Vec3 } | null { return this.flight ? { pos: this.flight.plan.toPos, target: this.flight.plan.toTarget } : null; }
  get lastFlightMs(): number { return this.lastFlyMs; }
  /** 카메라 고도 (m) */
  get altitudeMeters(): number { return worldUnitsToMeters(this.camera.position.y, this.tower.config.unitCm); }

  private setMode(m: CameraMode): void { if (this.mode !== m) { this.mode = m; this.onModeChange?.(m); } }

  flyTo(pos: Vec3, target: Vec3, mode: CameraMode): void {
    const from: Vec3 = [this.camera.position.x, this.camera.position.y, this.camera.position.z];
    const fromT: Vec3 = [this.controls.target.x, this.controls.target.y, this.controls.target.z];
    const durationMs = flightDuration(from, pos, this.reducedMotion);
    this.setMode(mode);
    if (durationMs === 0) { this.apply(pos, target); this.flight = null; this.lastFlyMs = 0; return; }
    this.flight = { plan: { fromPos: from, fromTarget: fromT, toPos: pos, toTarget: target, durationMs }, start: performance.now() };
  }

  private apply(pos: Vec3, target: Vec3): void {
    this.camera.position.set(pos[0], pos[1], pos[2]);
    this.controls.target.set(target[0], target[1], target[2]);
  }

  fullTower(): void {
    const v = fullTowerViewpoint(this.tower.height, (this.camera.fov * Math.PI) / 180, this.camera.aspect);
    this.flyTo(v.pos, v.target, "fullTower");
  }
  top(): void {
    const v = topViewpoint(this.tower.height, this.tower.config.diameter);
    this.flyTo(v.pos, v.target, "top");
  }
  /** altitude navigator: 특정 고도(m)로 */
  goToAltitude(meters: number): void {
    const v = altitudeViewpoint(metersToWorldUnits(meters, this.tower.config.unitCm), this.tower.height, this.tower.config.diameter);
    this.flyTo(v.pos, v.target, "explore");
  }
  heightMode(): void { this.setMode("heightMode"); }

  /**
   * Find My Pancake (Phase 1 §12): lookup → chunk activate → LOD → fly → highlight.
   * 반환: 결과와 lookup 시간.
   */
  async findPancake(id: number): Promise<{ result: FindResult; lookupMs: number } | null> {
    const t0 = performance.now();
    const result = await this.tower.findPancakeAsync(id);
    const lookupMs = performance.now() - t0;
    if (!result) return null;
    await this.renderer.ensureChunkHigh(result.chunkId);
    const v = findViewpoint(result.worldPosition, this.tower.config.diameter);
    this.renderer.select(result);
    this.flyTo(v.pos, v.target, "findPancake");
    return { result, lookupMs };
  }
  clearSelection(): void { this.renderer.select(null); }

  /** 매 프레임 */
  update(): void {
    if (this.flight) {
      const t = (performance.now() - this.flight.start) / this.flight.plan.durationMs;
      const f = flightAt(this.flight.plan, t);
      this.apply(f.pos, f.target);
      if (t >= 1) { this.lastFlyMs = this.flight.plan.durationMs; this.flight = null; }
    }
    this.controls.update();
  }

  dispose(): void { this.controls.dispose(); }
}
