import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

export type Queryable = { query<T = unknown>(sql: string, params?: unknown[]): Promise<{ rows: T[]; rowCount: number | null }> };

/** pg Pool 래퍼. tx() 는 하나의 커넥션에서 BEGIN/COMMIT, 실패 시 ROLLBACK. */
export class Db {
  readonly pool: pg.Pool;
  constructor(readonly url: string) {
    this.pool = new pg.Pool({ connectionString: url, max: 8 });
    // BIGINT → number (serial 은 2^53 안에서 충분)
    pg.types.setTypeParser(20, (v: string) => Number(v));
  }
  /** 관측용 (Phase 3A §26): 쿼리 수 / 누적 ms / 최근 지연 링 */
  metrics = { queries: 0, msTotal: 0, recent: [] as number[] };
  async query<T = unknown>(sql: string, params: unknown[] = []): Promise<{ rows: T[]; rowCount: number | null }> {
    const t0 = performance.now();
    try { return (await this.pool.query(sql, params)) as unknown as { rows: T[]; rowCount: number | null }; }
    finally { const ms = performance.now() - t0; this.metrics.queries++; this.metrics.msTotal += ms; this.metrics.recent.push(ms); if (this.metrics.recent.length > 500) this.metrics.recent.shift(); }
  }
  latencyP(p: number): number { if (!this.metrics.recent.length) return 0; const s = [...this.metrics.recent].sort((a, b) => a - b); return s[Math.floor((s.length - 1) * p)]; }
  async tx<T>(fn: (c: Queryable) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const q: Queryable = { query: (sql, params = []) => client.query(sql, params) as never };
      const out = await fn(q);
      await client.query("COMMIT");
      return out;
    } catch (e) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }
  async migrate(): Promise<void> {
    const sql = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "schema.sql"), "utf8");
    await this.pool.query(sql);
  }
  /** 테스트용: 모든 테이블 삭제 후 재생성 */
  async dropAll(): Promise<void> {
    await this.pool.query("DROP TABLE IF EXISTS world_state, drops, orders, pancakes, chunks, country_counters, simulation_jobs, world_snapshots, simulation_attempts, world_events, leader_lease, world_events_prune CASCADE");
  }
  /** 테스트용: 모든 테이블 비우기 */
  async reset(): Promise<void> {
    await this.pool.query("TRUNCATE world_state, drops, orders, pancakes, chunks, country_counters, simulation_jobs, world_snapshots, simulation_attempts, world_events, leader_lease, world_events_prune");
  }
  close(): Promise<void> { return this.pool.end(); }
}
