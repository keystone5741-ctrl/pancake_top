import * as THREE from "three";
import type { RenderQuality } from "./quality";

/** 모서리가 둥근 팬케이크 (LOD0/1 용). 반지름 r, 두께 t, 둘레 분할 seg. */
export function makePancakeGeometry(r: number, t: number, seg: number, roundedEdge: boolean): THREE.BufferGeometry {
  const h = t / 2;
  if (!roundedEdge) {
    const g = new THREE.CylinderGeometry(r, r, t, seg, 1, false);
    return g;
  }
  const edge = Math.min(t * 0.45, r * 0.15);
  const pts: THREE.Vector2[] = [new THREE.Vector2(0, -h), new THREE.Vector2(r - edge, -h)];
  const arc = seg >= 24 ? 5 : 3;
  for (let i = 1; i < arc; i++) {
    const a = -Math.PI / 2 + (Math.PI * i) / arc;
    pts.push(new THREE.Vector2(r - edge + Math.cos(a) * edge, Math.sin(a) * edge));
  }
  pts.push(new THREE.Vector2(r - edge, h), new THREE.Vector2(0, h));
  const g = new THREE.LatheGeometry(pts, seg);
  g.computeVertexNormals();
  return g;
}

export interface LodGeometries {
  lod: [THREE.BufferGeometry, THREE.BufferGeometry, THREE.BufferGeometry];
  triangles: [number, number, number];
  dispose(): void;
}

export function makeLodGeometries(diameter: number, thickness: number, q: RenderQuality): LodGeometries {
  const r = diameter / 2;
  const g0 = makePancakeGeometry(r, thickness, q.closeGeometry.segments, q.closeGeometry.roundedEdge);
  const g1 = makePancakeGeometry(r, thickness, q.mediumGeometry.segments, q.mediumGeometry.roundedEdge);
  const g2 = makePancakeGeometry(r, thickness, q.farGeometry.segments, q.farGeometry.roundedEdge);
  const tri = (g: THREE.BufferGeometry): number => (g.index ? g.index.count : g.attributes.position.count) / 3;
  return { lod: [g0, g1, g2], triangles: [tri(g0), tri(g1), tri(g2)], dispose: () => { g0.dispose(); g1.dispose(); g2.dispose(); } };
}
