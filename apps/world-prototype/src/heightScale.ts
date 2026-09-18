import { HEIGHT_MILESTONES, formatHeight, milestoneProgress, type HeightMilestone } from "pancake-core";

/**
 * Height Mode 축척 시각화 모델 (Phase 1 §17). 렌더링과 무관한 순수 데이터.
 * 탑 높이는 인자로만 받는다 — 호출자는 반드시 Tower.heightMeters (chunk header) 를 넘긴다. 가짜 카운터 금지.
 */
export interface ScaleMark { meters: number; label: string; y: number; kind: "milestone" | "tower" | "ground" | "decade" }

export interface ScaleModel {
  towerMeters: number;
  maxMeters: number;
  marks: ScaleMark[];
  next: HeightMilestone | null;
  progress: number;
  remainingMeters: number;
  /** 0 (바닥) .. 1 (맨 위) 로그 스케일 */
  y: (m: number) => number;
}

export function buildScaleModel(towerMeters: number, milestones: readonly HeightMilestone[] = HEIGHT_MILESTONES): ScaleModel {
  const p = milestoneProgress(towerMeters, milestones);
  // 다음 마일스톤 두 개까지 보여 준다 (SPACE 가 항상 보이도록 최소 100 km)
  const sorted = [...milestones].sort((a, b) => a.meters - b.meters);
  const idx = sorted.findIndex((m) => m.meters > towerMeters);
  const upto = idx >= 0 ? sorted[Math.min(sorted.length - 1, idx + 1)].meters : sorted[sorted.length - 1].meters;
  const maxMeters = Math.max(upto, 100_000, towerMeters * 1.2);
  const logMax = Math.log10(maxMeters + 1);
  const y = (m: number): number => Math.log10(Math.max(0, m) + 1) / logMax;
  const marks: ScaleMark[] = [{ meters: 0, label: "GROUND", y: 0, kind: "ground" }];
  for (const d of [10, 100, 1000, 10_000, 100_000, 1_000_000, 10_000_000, 100_000_000]) if (d < maxMeters) marks.push({ meters: d, label: formatHeight(d), y: y(d), kind: "decade" });
  for (const m of sorted) if (m.meters <= maxMeters) marks.push({ meters: m.meters, label: m.label, y: y(m.meters), kind: "milestone" });
  marks.push({ meters: towerMeters, label: `PANCAKE TOWER ${formatHeight(towerMeters)}`, y: y(towerMeters), kind: "tower" });
  marks.sort((a, b) => a.meters - b.meters);
  return { towerMeters, maxMeters, marks, next: p.next, progress: p.progress, remainingMeters: p.remainingMeters, y };
}

/** SVG 문자열 (world-prototype 의 Height Mode 화면) */
export function renderScaleSvg(model: ScaleModel, width: number, height: number): string {
  const pad = 60;
  const x = width * 0.42;
  const yPx = (v: number): number => height - pad - v * (height - 2 * pad);
  const lines: string[] = [];
  lines.push(`<line x1="${x}" y1="${yPx(0)}" x2="${x}" y2="${yPx(1)}" stroke="#2a2e3a" stroke-width="2"/>`);
  // 십진 눈금은 왼쪽, 마일스톤은 오른쪽, 탑 마크는 왼쪽 굵게. 탑 마크와 12 px 안에 겹치는 십진 라벨은 생략.
  const towerY = yPx(model.y(model.towerMeters));
  for (const m of model.marks) {
    const py = yPx(m.y);
    const color = m.kind === "tower" ? "#f6c453" : m.kind === "milestone" ? "#cfd3dc" : "#5a5f6c";
    const tick = m.kind === "tower" ? 26 : m.kind === "milestone" ? 16 : 8;
    lines.push(`<line x1="${x - tick}" y1="${py}" x2="${x + tick}" y2="${py}" stroke="${color}" stroke-width="${m.kind === "tower" ? 3 : 1}"/>`);
    if (m.kind === "decade" && Math.abs(py - towerY) < 12) continue;
    const left = m.kind === "tower" || m.kind === "decade" || m.kind === "ground";
    const tx = left ? x - tick - 8 : x + tick + 8;
    lines.push(`<text x="${tx}" y="${py + 4}" text-anchor="${left ? "end" : "start"}" fill="${color}" ${m.kind === "tower" ? 'font-weight="700" font-size="14"' : ""}>${m.label}${m.kind === "milestone" ? ` · ${formatHeight(m.meters)}` : ""}</text>`);
  }
  // 탑 막대
  lines.push(`<rect x="${x - 4}" y="${yPx(model.y(model.towerMeters))}" width="8" height="${yPx(0) - yPx(model.y(model.towerMeters))}" fill="#f6c453" opacity=".9"/>`);
  const nextText = model.next ? `NEXT ${model.next.label} · ${formatHeight(model.next.meters)} · remaining ${formatHeight(model.remainingMeters)} · ${(model.progress * 100).toFixed(1)}%` : "ALL MILESTONES REACHED";
  lines.push(`<text x="${width / 2}" y="${pad / 2 + 6}" text-anchor="middle" font-size="16" font-weight="700" fill="#fff">HEIGHT MODE — ${formatHeight(model.towerMeters)}</text>`);
  lines.push(`<text x="${width / 2}" y="${height - pad / 2 + 4}" text-anchor="middle" fill="#8a8f9c">${nextText}</text>`);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">${lines.join("")}</svg>`;
}
