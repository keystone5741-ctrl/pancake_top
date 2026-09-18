import pg from "pg";
import type { Db } from "../db/db";

/**
 * Single Drop Leader (Phase 3A §22~§23). PostgreSQL session-level advisory lock 을 전용 커넥션으로 잡는다.
 * 잡은 인스턴스만 scheduler / coordinator / simulation orchestration 을 한다. 커넥션이 끊기면(프로세스 죽음) 락이 풀리고
 * 다른 인스턴스가 다음 poll 에서 잡는다. leader_lease 행은 관측용(누가 언제부터 leader 인지, term).
 */
export class LeaderElector {
  private client: pg.Client | null = null;
  private timer: NodeJS.Timeout | null = null;
  private leader = false;
  private stopped = false;
  term = 0;
  metrics = { acquisitions: 0, losses: 0, heartbeats: 0 };
  constructor(readonly db: Db, readonly worldId: string, readonly instanceId: string, readonly intervalMs: number, readonly onChange: (isLeader: boolean) => void | Promise<void>) {}

  get isLeader(): boolean { return this.leader; }
  private get key(): string { return `hashtext('pancake-leader:' || '${this.worldId.replace(/'/g, "''")}')`; }

  async start(): Promise<void> {
    this.stopped = false;
    await this.poll();
    this.timer = setInterval(() => { void this.poll(); }, this.intervalMs);
  }
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await this.release();
  }
  /** 테스트용: 커넥션을 강제로 끊는다 (프로세스 crash 와 같은 효과) */
  async simulateCrash(): Promise<void> { const c = this.client; this.client = null; if (c) { c.removeAllListeners("error"); c.on("error", () => undefined); await c.end().catch(() => undefined); } if (this.leader) { this.leader = false; this.metrics.losses++; await this.onChange(false); } }

  private async release(): Promise<void> {
    const c = this.client; this.client = null;
    if (c) { await c.query(`SELECT pg_advisory_unlock(${this.key})`).catch(() => undefined); await c.end().catch(() => undefined); }
    if (this.leader) { this.leader = false; this.metrics.losses++; await this.onChange(false); }
  }

  async poll(): Promise<void> {
    if (this.stopped) return;
    try {
      if (!this.client) {
        const c = new pg.Client({ connectionString: this.db.url });
        c.on("error", () => { void this.lost(); });
        await c.connect();
        this.client = c;
      }
      if (!this.leader) {
        const r = await this.client.query<{ ok: boolean }>(`SELECT pg_try_advisory_lock(${this.key}) AS ok`);
        if (r.rows[0].ok) {
          const t = await this.client.query<{ term: number }>("INSERT INTO leader_lease (world_id, instance_id, acquired_at, heartbeat_at, term) VALUES ($1, $2, now(), now(), 1) ON CONFLICT (world_id) DO UPDATE SET instance_id = EXCLUDED.instance_id, acquired_at = now(), heartbeat_at = now(), term = leader_lease.term + 1 RETURNING term", [this.worldId, this.instanceId]);
          this.term = t.rows[0].term;
          this.leader = true; this.metrics.acquisitions++;
          await this.onChange(true);
        }
      } else {
        await this.client.query("UPDATE leader_lease SET heartbeat_at = now() WHERE world_id = $1 AND instance_id = $2", [this.worldId, this.instanceId]);
        this.metrics.heartbeats++;
      }
    } catch (e) {
      console.error("[leader]", this.instanceId, String((e as Error).message));
      await this.lost();
    }
  }
  private async lost(): Promise<void> {
    const c = this.client; this.client = null;
    if (c) await c.end().catch(() => undefined);
    if (this.leader) { this.leader = false; this.metrics.losses++; await this.onChange(false); }
  }
}
