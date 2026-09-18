import { EventEmitter } from "node:events";

/** Realtime 이벤트 (Phase 2 §31). WS 는 이 emitter 를 구독한다. */
export type WorldEvent = (
  | { type: "world.snapshot"; version: number; totalPancakes: number; committedPancakes: number; heightMeters: number; currentDrop: DropSummary | null; nextDropAt: string | null; serverTime: string; lastEventId?: number; instanceId?: string }
  | { type: "drop.opened"; dropId: string; scheduledAt: string; cutoffAt: string }
  | { type: "drop.queueUpdated"; dropId: string; queueSize: number; scheduledAt: string }
  | { type: "drop.closing"; dropId: string; scheduledAt: string; nextDropId: string }
  | { type: "drop.ready"; dropId: string; scheduledAt: string; pancakeCount: number; heightAfter: number }
  | { type: "drop.released"; dropId: string; startSerial: number | null; endSerial: number | null; pancakeCount: number; heightBefore: number | null; heightAfter: number | null; version: number }
  | { type: "drop.delayed"; dropId: string; scheduledAt: string; status: string; pending: number }
  | { type: "drop.failed"; dropId: string; error: string }
  | { type: "drop.aborted"; dropId: string; movedPancakes: number; toDropId: string | null }
  | { type: "drop.recovered"; dropId: string; mode: "retry" | "recover"; jobs: number }
  | { type: "world.updated"; version: number; committedPancakes: number; heightMeters: number; latestChunkId: number }
  | { type: "simulation.started"; dropId: string; jobId: string; startSerial: number; endSerial: number; attempt: number }
  | { type: "simulation.completed"; dropId: string; jobId: string; startSerial: number; endSerial: number; durationMs: number; version: number }
  | { type: "simulation.failed"; dropId: string; jobId: string; attempt: number; reason: string; error: string; willRetry: boolean }
  | { type: "chunk.committed"; chunkId: number; version: number; finalized: boolean; checksum: string; storageKey: string | null; count: number }
  | { type: "leader.changed"; instanceId: string; isLeader: boolean; term: number }
  | { type: "resync.done"; lastEventId: number }
) & { eventId?: number };

export interface DropSummary { dropId: string; status: string; scheduledAt: string; cutoffAt: string; pancakeCount: number; queueSize: number }

export class WorldEvents extends EventEmitter {
  emitEvent(e: WorldEvent): void { this.emit("event", e); }
  onEvent(fn: (e: WorldEvent) => void): () => void { this.on("event", fn); return () => this.off("event", fn); }
}
