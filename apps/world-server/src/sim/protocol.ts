/** Main ↔ Simulation worker 메시지 (Phase 2 §22). 바이너리는 PKT1 (pancake-physics towerFile) 로 주고받는다. */
export interface InitMsg { type: "INIT"; surface: Uint8Array | null; config: Record<string, unknown>; capacity: number; surfaceTopN: number; surfaceSliceSize: number }
export interface SimulateMsg { type: "SIMULATE_APPEND"; jobId: string; count: number; seed: number }
export interface SnapshotMsg { type: "SNAPSHOT" }
export interface CrashMsg { type: "DEV_CRASH" }
export interface PingMsg { type: "PING" }
export type ToWorker = InitMsg | SimulateMsg | SnapshotMsg | CrashMsg | PingMsg;

export interface SimMetrics { steps: number; wallMs: number; msPerPancake: number; maxActive: number; surfaceCount: number; penetrationMax: number; penetrationP95: number; tiltMedian: number; leaks: number }
export interface ReadyMsg { type: "READY"; spawned: number; heightUnits: number }
export interface ResultMsg { type: "RESULT"; jobId: string; finalTransforms: Uint8Array; surfaceAfter: Uint8Array; heightUnits: number; metrics: SimMetrics; spawned: number }
export interface SnapshotResultMsg { type: "SNAPSHOT_RESULT"; surface: Uint8Array; heightUnits: number; spawned: number }
export interface ErrorMsg { type: "ERROR"; jobId?: string; message: string }
export interface PongMsg { type: "PONG" }
export type FromWorker = ReadyMsg | ResultMsg | SnapshotResultMsg | ErrorMsg | PongMsg;
