import type { TowerData } from "pancake-core";

/**
 * Surface Collider Provider (Phase 1 §22).
 * 기존 탑 위에 새 Drop 을 계산할 때 어떤 팬케이크를 fixed 콜라이더로 둘지 정한다.
 * 기본 구현은 Phase 0.75 의 top-N. 향후 spatial surface / height map / adaptive set 으로 교체 가능.
 */
export interface SurfaceColliderProvider {
  readonly name: string;
  /** 콜라이더로 둘 팬케이크 index (TowerData 내 index) */
  getSurfaceColliders(tower: TowerData): number[];
}

export class TopNSurfaceProvider implements SurfaceColliderProvider {
  readonly name: string;
  constructor(readonly n = 64) { this.name = `top-${n}`; }
  getSurfaceColliders(tower: TowerData): number[] {
    const order = Array.from({ length: tower.count }, (_, i) => i).sort((a, b) => tower.py[b] - tower.py[a]);
    return order.slice(0, this.n);
  }
}

/**
 * 높이 기준: 최고점에서 depth(units) 안에 있는 팬케이크 전부 (개수는 탑 형태에 따라 달라짐).
 * 넓은 더미(Territory Drop 등)에서 top-N 보다 안전하다.
 */
export class HeightBandSurfaceProvider implements SurfaceColliderProvider {
  readonly name: string;
  constructor(readonly depth = 1.0, readonly max = 512) { this.name = `band-${depth}`; }
  getSurfaceColliders(tower: TowerData): number[] {
    let top = -Infinity;
    for (let i = 0; i < tower.count; i++) if (tower.py[i] > top) top = tower.py[i];
    const ids: number[] = [];
    for (let i = 0; i < tower.count; i++) if (tower.py[i] >= top - this.depth) ids.push(i);
    ids.sort((a, b) => tower.py[b] - tower.py[a]);
    return ids.slice(0, this.max);
  }
}
