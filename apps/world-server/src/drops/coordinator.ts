/**
 * DropCoordinator 상태 기계 (Phase 2 §5). 전이는 표로 명시하고 그 밖은 거부한다.
 */
export type DropStatus = "OPEN" | "SIMULATING" | "CLOSING" | "FINALIZING" | "READY" | "RELEASED" | "FAILED";

const TRANSITIONS: Record<DropStatus, readonly DropStatus[]> = {
  OPEN: ["SIMULATING", "CLOSING", "FAILED"],
  SIMULATING: ["CLOSING", "FAILED"],
  CLOSING: ["FINALIZING", "READY", "FAILED"],
  FINALIZING: ["READY", "FAILED"],
  READY: ["RELEASED", "FAILED"],
  RELEASED: [],
  FAILED: [],
};

export class InvalidTransitionError extends Error {
  constructor(readonly dropId: string, readonly from: DropStatus, readonly to: DropStatus) {
    super(`drop ${dropId}: invalid transition ${from} → ${to}`);
  }
}

export function canTransition(from: DropStatus, to: DropStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(dropId: string, from: DropStatus, to: DropStatus): void {
  if (!canTransition(from, to)) throw new InvalidTransitionError(dropId, from, to);
}

/** 구매를 받을 수 있는 상태 */
export function acceptsPurchases(s: DropStatus): boolean {
  return s === "OPEN" || s === "SIMULATING";
}
export function isTerminal(s: DropStatus): boolean {
  return s === "RELEASED" || s === "FAILED";
}
