import { HEIGHT_MILESTONES, formatHeight, type HeightMilestone } from "pancake-core";

export interface AltitudeStop { meters: number; label: string; milestone?: HeightMilestone }

/**
 * 고도 내비게이터의 눈금 (Phase 1 §14). GROUND 0 m → 1 km → 10 km → 50 km → 100 km SPACE … 탑 높이까지 + 다음 마일스톤.
 * 로그 스케일 위치 0..1 도 같이 준다 (slider/vertical scale 용).
 */
export function altitudeStops(towerHeightMeters: number, milestones: readonly HeightMilestone[] = HEIGHT_MILESTONES): { stops: AltitudeStop[]; maxMeters: number; position: (m: number) => number } {
  const base: AltitudeStop[] = [{ meters: 0, label: "GROUND" }];
  const next = milestones.filter((m) => m.meters > towerHeightMeters).sort((a, b) => a.meters - b.meters)[0];
  const maxMeters = Math.max(towerHeightMeters * 1.1, next ? next.meters : towerHeightMeters, 100);
  const decades = [1, 10, 100, 1000, 10_000, 100_000, 1_000_000, 10_000_000, 100_000_000];
  for (const m of decades) if (m > 0 && m <= maxMeters) base.push({ meters: m, label: formatHeight(m) });
  for (const ms of milestones) if (ms.meters <= maxMeters) base.push({ meters: ms.meters, label: ms.label, milestone: ms });
  base.push({ meters: towerHeightMeters, label: `TOWER ${formatHeight(towerHeightMeters)}` });
  const stops = base.sort((a, b) => a.meters - b.meters).filter((s, i, arr) => i === 0 || s.meters !== arr[i - 1].meters);
  const logMax = Math.log10(maxMeters + 1);
  const position = (m: number): number => Math.log10(Math.max(0, m) + 1) / logMax;
  return { stops, maxMeters, position };
}
