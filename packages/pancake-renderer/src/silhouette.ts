import * as THREE from "three";

export type FarViewMode = "pure" | "silhouette" | "atmospheric" | "both";

/**
 * Far Tower 시각 보조 (Phase 1 §9, §10, §35).
 * 실제 인스턴스와 별개의 레이어. 충돌·높이에 영향 없음. 가까워지면 fade out.
 *  - silhouette: 탑 축을 따라 1px 선 (depthTest 없음, 항상 1 px)
 *  - atmospheric: 축 주변의 부드러운 발광 빌보드 + 바닥 마커 링
 */
export class SilhouetteAssist {
  readonly group = new THREE.Group();
  private readonly line: THREE.Line;
  private readonly lineMat: THREE.LineBasicMaterial;
  private readonly glow: THREE.Mesh;
  private readonly glowMat: THREE.MeshBasicMaterial;
  private readonly ring: THREE.Mesh;
  private readonly ringMat: THREE.MeshBasicMaterial;
  mode: FarViewMode = "silhouette";
  /** 팬케이크 투영 직경이 이 px 이상이면 완전히 사라진다 */
  fadeOutPx = 6;
  fadeInPx = 1.5;

  constructor() {
    this.lineMat = new THREE.LineBasicMaterial({ color: "#f6c453", transparent: true, opacity: 0.9, depthTest: false, depthWrite: false });
    this.line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 1, 0)]), this.lineMat);
    this.line.renderOrder = 5;
    this.glowMat = new THREE.MeshBasicMaterial({ color: "#f6c453", map: makeGlowTexture(), transparent: true, opacity: 0.55, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
    this.glow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.glowMat);
    this.glow.renderOrder = 4;
    this.ringMat = new THREE.MeshBasicMaterial({ color: "#f6c453", transparent: true, opacity: 0.5, depthWrite: false, side: THREE.DoubleSide });
    this.ring = new THREE.Mesh(new THREE.RingGeometry(0.8, 1, 48), this.ringMat);
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.position.y = 0.01;
    this.group.add(this.line, this.glow, this.ring);
  }

  /**
   * @param heightUnits 탑 높이 (world units, Tower.height)
   * @param projectedPx 카메라 위치에서 본 팬케이크 투영 직경 (px)
   */
  update(heightUnits: number, camera: THREE.Camera, projectedPx: number): void {
    const enabled = this.mode !== "pure";
    this.group.visible = enabled && heightUnits > 0;
    if (!this.group.visible) return;
    const fade = THREE.MathUtils.clamp((this.fadeOutPx - projectedPx) / (this.fadeOutPx - this.fadeInPx), 0, 1);
    const useLine = this.mode === "silhouette" || this.mode === "both";
    const useAtmo = this.mode === "atmospheric" || this.mode === "both";
    this.line.visible = useLine && fade > 0;
    this.glow.visible = useAtmo && fade > 0;
    this.ring.visible = useAtmo && fade > 0;
    this.line.scale.set(1, heightUnits, 1);
    this.lineMat.opacity = 0.9 * fade;
    // 발광 빌보드: 카메라를 향하고, 폭은 카메라 거리에 비례(화면에서 대략 일정 px)
    const camPos = new THREE.Vector3().setFromMatrixPosition(camera.matrixWorld);
    const dist = Math.hypot(camPos.x, camPos.y - heightUnits / 2, camPos.z);
    const width = Math.max(1, dist * 0.02);
    this.glow.scale.set(width, heightUnits, 1);
    this.glow.position.set(0, heightUnits / 2, 0);
    this.glow.lookAt(camPos.x, heightUnits / 2, camPos.z);
    this.glowMat.opacity = 0.55 * fade;
    const ringR = Math.max(2, dist * 0.02);
    this.ring.scale.set(ringR, ringR, 1);
    this.ringMat.opacity = 0.5 * fade;
  }
}

/** 가로 방향 부드러운 발광 (가운데 밝고 양끝 투명). 헤드리스/테스트 환경에서는 document 가 없을 수 있어 null 허용. */
function makeGlowTexture(): THREE.Texture | null {
  if (typeof document === "undefined") return null;
  const c = document.createElement("canvas");
  c.width = 64; c.height = 4;
  const ctx = c.getContext("2d");
  if (!ctx) return null;
  const g = ctx.createLinearGradient(0, 0, 64, 0);
  g.addColorStop(0, "rgba(255,255,255,0)");
  g.addColorStop(0.5, "rgba(255,255,255,1)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 4);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
