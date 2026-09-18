import * as THREE from "three";
import type { FindResult } from "tower-engine";

/**
 * 선택 팬케이크 강조 (Phase 1 §13). 원본 인스턴스 material 은 건드리지 않는다.
 * 같은 transform 에 emissive 복제 mesh + 살짝 큰 halo ring 을 겹쳐 그린다.
 */
export class HighlightMarker {
  readonly group = new THREE.Group();
  private readonly overlay: THREE.Mesh;
  private readonly halo: THREE.Mesh;
  private selected: FindResult | null = null;
  private t = 0;

  constructor(diameter: number, thickness: number, geometry: THREE.BufferGeometry) {
    this.overlay = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: "#ffd166", emissive: "#ff5a36", emissiveIntensity: 0.9, roughness: 0.5, transparent: true, opacity: 0.95, depthTest: true }));
    this.overlay.renderOrder = 10;
    this.halo = new THREE.Mesh(new THREE.TorusGeometry(diameter * 0.62, thickness * 0.35, 8, 48), new THREE.MeshBasicMaterial({ color: "#ff5a36", transparent: true, opacity: 0.85, depthTest: false }));
    this.halo.rotation.x = Math.PI / 2;
    this.halo.renderOrder = 11;
    this.group.add(this.overlay, this.halo);
    this.group.visible = false;
  }

  get current(): FindResult | null { return this.selected; }

  select(r: FindResult): void {
    this.selected = r;
    const [x, y, z] = r.transform.position;
    const [qx, qy, qz, qw] = r.transform.quaternion;
    this.overlay.position.set(x, y, z);
    this.overlay.quaternion.set(qx, qy, qz, qw);
    this.overlay.scale.set(r.transform.scale * 1.02, r.transform.thicknessScale * 1.05, r.transform.scale * 1.02);
    this.halo.position.set(x, y, z);
    this.halo.quaternion.copy(this.overlay.quaternion).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2));
    this.group.visible = true;
  }
  clear(): void { this.selected = null; this.group.visible = false; }

  /** halo 펄스 */
  update(dtMs: number): void {
    if (!this.selected) return;
    this.t += dtMs;
    const s = 1 + 0.08 * Math.sin(this.t / 250);
    this.halo.scale.set(s, s, s);
  }
}
