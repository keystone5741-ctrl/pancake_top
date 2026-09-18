/**
 * Phase 0.5 Stacking 품질 계측.
 * 높이 / 수평 퍼짐 / 기울기 / 층 간격 / 침투. 렌더러와 무관, Node 와 브라우저 공용.
 */
export interface TowerSnapshot {
  count: number;
  diameter: number;
  thickness: number;
  unitCm: number;
  px: Float32Array;
  py: Float32Array;
  pz: Float32Array;
  qx: Float32Array;
  qy: Float32Array;
  qz: Float32Array;
  qw: Float32Array;
  scale: Float32Array;
  tscale: Float32Array;
  /** 포함할 id 를 고르는 필터 (예: ACTIVE 제외). 없으면 전부. */
  include?: (id: number) => boolean;
}

export interface Quantiles {
  median: number;
  p05?: number;
  p90?: number;
  p95?: number;
  max: number;
}

export interface StackingMetrics {
  count: number;
  /**
   * towerM: 실측 최고점. idealM: 공칭 두께 × 개수 (nominal). geometryM: 각 팬케이크의 실제 두께(tscale 반영) 합.
   * efficiency = nominal 기준 (Phase 0/0.5 와 동일 정의). geometryEfficiency = 실제 두께 합 기준.
   * 두 값의 차이가 두께 편차 정의 때문인지, 배치(기울기·공기층) 때문인지 구분한다 (Phase 0.75 §2).
   */
  height: { towerM: number; idealM: number; efficiency: number; geometryM: number; geometryEfficiency: number };
  /** 중심축(원점)으로부터 중심점 거리 (m) */
  spread: Quantiles & { p90: number; p95: number };
  /** 수평면 대비 기울기 (deg) */
  tilt: Quantiles & { p90: number; p95: number };
  /** 정렬된 중심 y 의 인접 간격 / 두께 (비율) */
  layerSpacing: { median: number; p05: number; p95: number };
  /** 상호 침투 (두께 대비 비율). 평균 법선 기준 두께 방향 겹침. */
  penetration: { overlappingPairs: number; max: number; p95: number; checkedPairs: number };
  belowGround: number;
  nonFinite: number;
}

export function quantile(sorted: ArrayLike<number>, p: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * p)));
  return sorted[i];
}

/** 쿼터니언 로컬 Y 축의 월드 Y 성분 → 기울기(rad) */
export function tiltOf(qx: number, qy: number, qz: number, qw: number): number {
  void qy; void qw;
  const upY = 1 - 2 * (qx * qx + qz * qz);
  return Math.acos(Math.max(-1, Math.min(1, upY)));
}

export function computeStackingMetrics(s: TowerSnapshot, penetrationThreshold = 0.05): StackingMetrics {
  const ids: number[] = [];
  let nonFinite = 0;
  for (let i = 0; i < s.count; i++) {
    if (s.include && !s.include(i)) continue;
    if (!Number.isFinite(s.px[i]) || !Number.isFinite(s.py[i]) || !Number.isFinite(s.pz[i])) { nonFinite++; continue; }
    ids.push(i);
  }
  const n = ids.length;
  const toM = s.unitCm / 100;

  let topY = 0;
  let belowGround = 0;
  let geometryHeight = 0;
  const spread = new Float64Array(n);
  const tilt = new Float64Array(n);
  const ys = new Float64Array(n);
  ids.forEach((id, k) => {
    const half = (s.thickness * s.tscale[id]) / 2;
    geometryHeight += half * 2;
    const top = s.py[id] + half;
    if (top > topY) topY = top;
    if (s.py[id] - half < -s.thickness * penetrationThreshold) belowGround++;
    spread[k] = Math.hypot(s.px[id], s.pz[id]);
    tilt[k] = (tiltOf(s.qx[id], s.qy[id], s.qz[id], s.qw[id]) * 180) / Math.PI;
    ys[k] = s.py[id];
  });
  spread.sort();
  tilt.sort();
  ys.sort();
  const gaps = new Float64Array(Math.max(0, n - 1));
  for (let k = 1; k < n; k++) gaps[k - 1] = (ys[k] - ys[k - 1]) / s.thickness;
  gaps.sort();

  // 침투: y 로 정렬한 뒤 수직 창(두께 합 이내) 안에서만 검사. O(n × 창 크기).
  // 두 팬케이크의 평균 법선 n 을 기준으로, 중심 차이를 n 방향(두께 방향)과 면내 방향으로 나눈다.
  // 면내 거리 < 반지름 합이면서 두께 방향 거리 < 반두께 합이면 침투. 평행 원반 근사를 기울기까지 확장한 것.
  const order = Array.from(ids).sort((a, b) => s.py[a] - s.py[b]);
  const maxHalf = s.thickness * 0.5 * 1.3;
  const upOf = (id: number): [number, number, number] => {
    const x = s.qx[id], y = s.qy[id], z = s.qz[id], w = s.qw[id];
    return [2 * (x * y - w * z), 1 - 2 * (x * x + z * z), 2 * (y * z + w * x)];
  };
  const ups = new Map<number, [number, number, number]>();
  for (const id of ids) ups.set(id, upOf(id));
  const pens: number[] = [];
  let checked = 0;
  let overlapping = 0;
  for (let i = 0; i < order.length; i++) {
    const id = order[i];
    const ra = (s.diameter * s.scale[id]) / 2, ha = (s.thickness * s.tscale[id]) / 2;
    const ua = ups.get(id)!;
    for (let j = i + 1; j < order.length; j++) {
      const other = order[j];
      const dy = s.py[other] - s.py[id];
      // 기울어진 팬케이크는 중심 y 차이가 두께 합보다 커도 가장자리에서 닿을 수 있으므로 창을 반지름 합 × sin(최대 기울기) 만큼 넓힌다
      if (dy > ha + maxHalf + (ra + s.diameter / 2) * 0.5) break;
      const rb = (s.diameter * s.scale[other]) / 2, hb = (s.thickness * s.tscale[other]) / 2;
      const dx = s.px[other] - s.px[id], dz = s.pz[other] - s.pz[id];
      if (Math.hypot(dx, dz) >= ra + rb) continue;
      const ub = ups.get(other)!;
      let nx = ua[0] + ub[0], ny = ua[1] + ub[1], nz = ua[2] + ub[2];
      const nl = Math.hypot(nx, ny, nz) || 1;
      nx /= nl; ny /= nl; nz /= nl;
      const along = dx * nx + dy * ny + dz * nz;              // 두께 방향 거리
      const inPlane = Math.sqrt(Math.max(0, dx * dx + dy * dy + dz * dz - along * along)); // 면내 거리
      if (inPlane >= ra + rb) continue;
      checked++;
      const overlap = ha + hb - Math.abs(along);
      if (overlap <= 0) continue;
      const pen = overlap / s.thickness;
      if (pen > penetrationThreshold) { overlapping++; pens.push(pen); }
    }
  }
  pens.sort((a, b) => a - b);

  return {
    count: n,
    height: {
      towerM: topY * toM,
      idealM: n * s.thickness * toM,
      efficiency: n ? topY / (n * s.thickness) : 0,
      geometryM: geometryHeight * toM,
      geometryEfficiency: geometryHeight > 0 ? topY / geometryHeight : 0,
    },
    spread: { median: quantile(spread, 0.5) * toM, p90: quantile(spread, 0.9) * toM, p95: quantile(spread, 0.95) * toM, max: (n ? spread[n - 1] : 0) * toM },
    tilt: { median: quantile(tilt, 0.5), p90: quantile(tilt, 0.9), p95: quantile(tilt, 0.95), max: n ? tilt[n - 1] : 0 },
    layerSpacing: { median: quantile(gaps, 0.5), p05: quantile(gaps, 0.05), p95: quantile(gaps, 0.95) },
    penetration: { overlappingPairs: overlapping, max: pens.length ? pens[pens.length - 1] : 0, p95: quantile(pens, 0.95), checkedPairs: checked },
    belowGround,
    nonFinite,
  };
}

export function formatMetrics(m: StackingMetrics): string {
  const f = (v: number, d = 2): string => v.toFixed(d);
  return [
    `height ${f(m.height.towerM)} m / nominal ${f(m.height.idealM)} m (${f(m.height.efficiency * 100, 1)}%) / geometry ${f(m.height.geometryM)} m (${f(m.height.geometryEfficiency * 100, 1)}%)`,
    `spread(m) median ${f(m.spread.median, 3)} p90 ${f(m.spread.p90, 3)} p95 ${f(m.spread.p95, 3)} max ${f(m.spread.max, 3)}`,
    `tilt(deg) median ${f(m.tilt.median)} p90 ${f(m.tilt.p90)} p95 ${f(m.tilt.p95)} max ${f(m.tilt.max)}`,
    `layer gap/th median ${f(m.layerSpacing.median, 3)} p05 ${f(m.layerSpacing.p05, 3)} p95 ${f(m.layerSpacing.p95, 3)}`,
    `penetration pairs ${m.penetration.overlappingPairs}/${m.penetration.checkedPairs} max ${f(m.penetration.max, 3)} p95 ${f(m.penetration.p95, 3)} (×thickness)`,
    `belowGround ${m.belowGround} nonFinite ${m.nonFinite}`,
  ].join("\n");
}
