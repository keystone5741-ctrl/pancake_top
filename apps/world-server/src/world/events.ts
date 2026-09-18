import { EventEmitter } from "node:events";

/** Realtime 이벤트 (Phase 2 §31). WS 는 이 emitter 를 구독한다. */
export type WorldEvent =
  | { type: "world.snapshot"; version: number; totalPancakes: number; committedPancakes: number; heightMeters: number; currentDrop: DropSummary | null; nextDropAt: string | null; serverTime: string }
  | { type: "drop.queueUpdated"; dropId: string; queueSize: number; scheduledAt: string }
  | { type: "drop.closing"; dropId: string; scheduledAt: string; nextDropId: string }
  | { type: "drop.ready"; dropId: string; scheduledAt: string; pancakeCount: number; heightAfter: number }
  | { type: "drop.released"; dropId: string; startSerial: number | null; endSerial: number | null; pancakeCount: number; heightBefore: number | null; heightAfter: number | null; version: number }
  | { type: "drop.delayed"; dropId: string; scheduledAt: string; status: string; pending: number }
  | { type: "drop.failed"; dropId: string; error: string }
  | { type: "world.updated"; version: number; committedPancakes: number; heightMeters: number; latestChunkId: number };

export interface DropSummary { dropId: string; status: string; scheduledAt: string; cutoffAt: string; pancakeCount: number; queueSize: number }

export class WorldEvents extends EventEmitter {
  emitEvent(e: WorldEvent): void { this.emit("event", e); }
  onEvent(fn: (e: WorldEvent) => void): () => void { this.on("event", fn); return () => this.off("event", fn); }
}
