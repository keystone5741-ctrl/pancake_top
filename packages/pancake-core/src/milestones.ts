/**
 * Height Milestone (Phase 1 §16). 데이터 구조와 generic API 만 만든다.
 * 실제 서비스에 어떤 랜드마크를 쓸지는 UX 단계에서 정한다. 아래 목록은 예시 데이터이며 교체 가능하다.
 */
export type MilestoneCategory = "building" | "landmark" | "mountain" | "aviation" | "atmosphere" | "space" | "orbit" | "moon";

export interface HeightMilestone {
  id: string;
  /** 표시 이름 (i18n 키로 바꿀 수 있게 id 와 분리) */
  label: string;
  meters: number;
  category: MilestoneCategory;
}

export const HEIGHT_MILESTONES: readonly HeightMilestone[] = [
  { id: "building", label: "Building", meters: 100, category: "building" },
  { id: "eiffel", label: "Eiffel Tower", meters: 330, category: "landmark" },
  { id: "burj", label: "Burj Khalifa", meters: 828, category: "landmark" },
  { id: "everest", label: "Mount Everest", meters: 8849, category: "mountain" },
  { id: "airliner", label: "Airliner cruise", meters: 11000, category: "aviation" },
  { id: "stratosphere", label: "Stratosphere", meters: 50000, category: "atmosphere" },
  { id: "karman", label: "SPACE (Kármán line)", meters: 100000, category: "space" },
  { id: "iss", label: "ISS orbit", meters: 408000, category: "orbit" },
  { id: "geo", label: "Geostationary orbit", meters: 35786000, category: "orbit" },
  { id: "moon", label: "Moon", meters: 384400000, category: "moon" },
] as const;

export interface MilestoneProgress {
  reached: HeightMilestone[];
  next: HeightMilestone | null;
  /** 이전 마일스톤(또는 0) → 다음 마일스톤 사이 진행률 0..1 */
  progress: number;
  remainingMeters: number;
}

export function milestoneProgress(heightMeters: number, list: readonly HeightMilestone[] = HEIGHT_MILESTONES): MilestoneProgress {
  const sorted = [...list].sort((a, b) => a.meters - b.meters);
  const reached = sorted.filter((m) => heightMeters >= m.meters);
  const next = sorted.find((m) => heightMeters < m.meters) ?? null;
  const prevM = reached.length ? reached[reached.length - 1].meters : 0;
  const progress = next ? Math.min(1, Math.max(0, (heightMeters - prevM) / (next.meters - prevM))) : 1;
  return { reached, next, progress, remainingMeters: next ? next.meters - heightMeters : 0 };
}
