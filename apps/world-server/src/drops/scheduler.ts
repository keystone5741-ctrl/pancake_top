/**
 * 10분 Drop 스케줄러 (Phase 2 §6). Drop id 는 UTC 절대 시각으로 결정된다: drop_20260918T031000Z.
 * 서버가 재시작해도 같은 시각이면 같은 id 가 나온다. 랜덤 UUID 를 쓰지 않는다.
 */
export interface DropSlot {
  dropId: string;
  scheduledAt: Date;
  cutoffAt: Date;
}

export class DropScheduler {
  constructor(readonly intervalSeconds = 600, readonly cutoffSeconds = 60) {
    if (cutoffSeconds >= intervalSeconds) throw new Error("cutoff must be shorter than the interval");
  }

  static idFor(scheduledAt: Date): string {
    const s = scheduledAt.toISOString(); // 2026-09-18T03:10:00.000Z
    return `drop_${s.slice(0, 4)}${s.slice(5, 7)}${s.slice(8, 10)}T${s.slice(11, 13)}${s.slice(14, 16)}${s.slice(17, 19)}Z`;
  }
  static parseId(dropId: string): Date | null {
    const m = /^drop_(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(dropId);
    if (!m) return null;
    return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
  }

  slotFor(scheduledAt: Date): DropSlot {
    return { dropId: DropScheduler.idFor(scheduledAt), scheduledAt, cutoffAt: new Date(scheduledAt.getTime() - this.cutoffSeconds * 1000) };
  }

  /** now 이후 첫 경계 (now 가 정확히 경계면 다음 경계) */
  nextBoundary(now: Date): Date {
    const ms = this.intervalSeconds * 1000;
    return new Date(Math.floor(now.getTime() / ms) * ms + ms);
  }

  /** 지금 구매가 들어가는 Drop: cutoff 전이면 다음 경계, cutoff 를 지났으면 그 다음 경계 */
  currentDrop(now: Date): DropSlot {
    let slot = this.slotFor(this.nextBoundary(now));
    if (now.getTime() >= slot.cutoffAt.getTime()) slot = this.slotFor(new Date(slot.scheduledAt.getTime() + this.intervalSeconds * 1000));
    return slot;
  }

  /** 주어진 Drop 다음 Drop */
  after(slot: DropSlot): DropSlot {
    return this.slotFor(new Date(slot.scheduledAt.getTime() + this.intervalSeconds * 1000));
  }
}
