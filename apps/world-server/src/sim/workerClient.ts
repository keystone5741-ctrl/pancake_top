import { fork, type ChildProcess } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FromWorker, ResultMsg, SnapshotResultMsg, ToWorker } from "./protocol";

export class WorkerCrashError extends Error { constructor(readonly code: number | null, readonly signal: string | null) { super(`simulation worker exited (code ${code}, signal ${signal})`); } }

export interface WorkerClientOptions {
  config: Record<string, unknown>;
  capacity: number;
  surfaceTopN: number;
  surfaceSliceSize: number;
  onCrash?: (e: WorkerCrashError) => void;
}

/**
 * Simulation worker 클라이언트 (Phase 2 §21, §23). 자식 프로세스를 띄우고 메시지를 주고받는다.
 * worker 가 죽으면 대기 중인 요청은 WorkerCrashError 로 거부되고, 다음 ensure() 에서 새 프로세스를 띄운다.
 * main 프로세스는 절대 죽지 않는다.
 */
export class SimulationWorkerClient {
  private child: ChildProcess | null = null;
  private pending = new Map<string, { resolve: (m: FromWorker) => void; reject: (e: Error) => void }>();
  private initialised = false;
  crashes = 0;
  restarts = 0;
  constructor(readonly opts: WorkerClientOptions) {}

  get alive(): boolean { return this.child !== null && this.child.exitCode === null && this.child.signalCode === null; }
  get ready(): boolean { return this.alive && this.initialised; }

  private spawn(): ChildProcess {
    const entry = join(dirname(fileURLToPath(import.meta.url)), "worker.ts");
    const child = fork(entry, [], { execArgv: ["--import", "tsx"], serialization: "advanced", stdio: ["ignore", "inherit", "inherit", "ipc"] });
    child.on("message", (m: FromWorker) => this.onMessage(m));
    child.on("exit", (code, signal) => {
      const err = new WorkerCrashError(code, signal);
      if (this.child === child) { this.child = null; this.initialised = false; }
      if (code !== 0 || signal) { this.crashes++; this.opts.onCrash?.(err); }
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
    });
    this.restarts++;
    return child;
  }

  private onMessage(m: FromWorker): void {
    const REPLY_KEY: Record<string, string> = { READY: "INIT", SNAPSHOT_RESULT: "SNAPSHOT", PONG: "PING" };
    const key = m.type === "RESULT" ? m.jobId : m.type === "ERROR" && m.jobId ? m.jobId : (REPLY_KEY[m.type] ?? m.type);
    const p = this.pending.get(key) ?? (m.type === "ERROR" ? this.pending.get("SNAPSHOT") ?? this.pending.get("INIT") : undefined);
    if (!p) return;
    this.pending.delete(key);
    if (m.type === "ERROR") p.reject(new Error(m.message)); else p.resolve(m);
  }

  private request(key: string, msg: ToWorker, timeoutMs: number): Promise<FromWorker> {
    if (!this.child) throw new Error("worker not spawned");
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(key); reject(new Error(`worker timeout: ${key}`)); }, timeoutMs);
      this.pending.set(key, { resolve: (m) => { clearTimeout(timer); resolve(m); }, reject: (e) => { clearTimeout(timer); reject(e); } });
      this.child!.send(msg);
    });
  }

  /** 살아 있고 INIT 된 worker 를 보장한다. 죽었으면 surface 로 다시 만든다. */
  async ensure(surface: Uint8Array | null): Promise<{ spawned: number; heightUnits: number }> {
    if (this.ready) { const c = this.child!; return { spawned: -1, heightUnits: -1, ...(c ? {} : {}) }; }
    if (!this.alive) this.child = this.spawn();
    const m = await this.request("INIT", { type: "INIT", surface, config: this.opts.config, capacity: this.opts.capacity, surfaceTopN: this.opts.surfaceTopN, surfaceSliceSize: this.opts.surfaceSliceSize }, 60_000);
    if (m.type !== "READY") throw new Error("unexpected init reply");
    this.initialised = true;
    return { spawned: m.spawned, heightUnits: m.heightUnits };
  }
  /** 강제 재초기화 (capacity 회수 등) */
  async reinit(surface: Uint8Array | null): Promise<void> { this.initialised = false; await this.ensure(surface); }

  async simulate(jobId: string, count: number, seed: number, timeoutMs = 10 * 60_000): Promise<ResultMsg> {
    const m = await this.request(jobId, { type: "SIMULATE_APPEND", jobId, count, seed }, timeoutMs);
    if (m.type !== "RESULT") throw new Error("unexpected simulate reply");
    return m;
  }
  async snapshot(): Promise<SnapshotResultMsg> {
    const m = await this.request("SNAPSHOT", { type: "SNAPSHOT" }, 60_000);
    if (m.type !== "SNAPSHOT_RESULT") throw new Error("unexpected snapshot reply");
    return m;
  }
  async ping(): Promise<boolean> { try { const m = await this.request("PING", { type: "PING" }, 5000); return m.type === "PONG"; } catch { return false; } }
  /** 개발/테스트: worker 를 고의로 죽인다 */
  devCrash(): void { this.child?.send({ type: "DEV_CRASH" } satisfies ToWorker); }
  async stop(): Promise<void> { const c = this.child; this.child = null; this.initialised = false; if (c && c.exitCode === null) { c.kill(); await new Promise((r) => c.once("exit", r)); } }
}
