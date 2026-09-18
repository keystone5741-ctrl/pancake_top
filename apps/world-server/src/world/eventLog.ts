import pg from "pg";
import type { Db } from "../db/db";
import type { WorldEvent } from "./events";

/**
 * Durable world event log (Phase 3A §17~§20).
 * append: world_events 행 + pg_notify. 모든 인스턴스가 LISTEN 해서 자기 WS 클라이언트에 broadcast 한다.
 * replay: lastEventId 이후 이벤트. retention 으로 지운 경계(pruned_up_to) 보다 오래됐으면 snapshot 으로.
 */
export interface StoredEvent { eventId: number; worldVersion: number; type: string; dropId: string | null; payload: WorldEvent; createdAt: string; instanceId: string | null }
export interface EventLogOptions { worldId: string; instanceId: string; retentionHours: number; retentionCount: number; auditTypes: string[] }

export const CHANNEL = "world_events";

export class EventLog {
  private listener: pg.Client | null = null;
  private lastSeen = 0;
  private fetching: Promise<void> | null = null;
  private again = false;
  private subscribers = new Set<(e: StoredEvent) => void>();
  metrics = { appended: 0, delivered: 0, replayed: 0, pruned: 0, lagMsLast: 0, lagMsMax: 0 };
  constructor(readonly db: Db, readonly opts: EventLogOptions) {}

  /** 이벤트를 기록하고 (local 즉시 + 다른 인스턴스 NOTIFY) event_id 를 돌려준다 */
  async append(e: WorldEvent, worldVersion: number): Promise<StoredEvent> {
    const dropId = "dropId" in e ? (e as { dropId: string }).dropId : null;
    const retain = this.opts.auditTypes.includes(e.type);
    const r = await this.db.query<{ event_id: number; created_at: Date }>(
      "INSERT INTO world_events (world_version, type, drop_id, payload, retain, instance_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING event_id, created_at",
      [worldVersion, e.type, dropId, JSON.stringify(e), retain, this.opts.instanceId],
    );
    const stored: StoredEvent = { eventId: r.rows[0].event_id, worldVersion, type: e.type, dropId, payload: e, createdAt: r.rows[0].created_at.toISOString(), instanceId: this.opts.instanceId };
    this.metrics.appended++;
    this.lastSeen = Math.max(this.lastSeen, stored.eventId);
    this.deliver(stored);
    await this.db.query("SELECT pg_notify($1, $2)", [CHANNEL, String(stored.eventId)]).catch(() => undefined);
    return stored;
  }

  onEvent(fn: (e: StoredEvent) => void): () => void { this.subscribers.add(fn); return () => this.subscribers.delete(fn); }
  private deliver(e: StoredEvent): void {
    this.metrics.delivered++;
    const lag = Date.now() - new Date(e.createdAt).getTime();
    this.metrics.lagMsLast = lag; if (lag > this.metrics.lagMsMax) this.metrics.lagMsMax = lag;
    for (const fn of this.subscribers) { try { fn(e); } catch (err) { console.error("[events] subscriber", err); } }
  }

  /** 다른 인스턴스의 이벤트를 받기 위한 LISTEN (전용 커넥션) */
  async startListening(): Promise<void> {
    if (this.listener) return;
    this.lastSeen = Math.max(this.lastSeen, await this.latestId());
    const c = new pg.Client({ connectionString: this.db.url });
    await c.connect();
    c.on("notification", () => { void this.fetchNew(); });
    c.on("error", (e) => { console.error("[events] listener", e.message); });
    await c.query(`LISTEN ${CHANNEL}`);
    this.listener = c;
  }
  async stopListening(): Promise<void> { const c = this.listener; this.listener = null; if (c) await c.end().catch(() => undefined); }

  /** lastSeen 이후를 순서대로 가져와 배달 (자기 것은 append 때 이미 배달했으므로 건너뛴다) */
  private fetchNew(): Promise<void> {
    if (this.fetching) { this.again = true; return this.fetching; }
    this.fetching = (async () => {
      do {
        this.again = false;
        const rows = await this.after(this.lastSeen, 1000);
        for (const e of rows) { this.lastSeen = Math.max(this.lastSeen, e.eventId); if (e.instanceId !== this.opts.instanceId) this.deliver(e); }
      } while (this.again);
    })().catch((e) => { console.error("[events] fetch", e); }).finally(() => { this.fetching = null; });
    return this.fetching;
  }

  async latestId(): Promise<number> { return (await this.db.query<{ m: number | null }>("SELECT MAX(event_id) AS m FROM world_events")).rows[0].m ?? 0; }
  async prunedUpTo(): Promise<number> { return (await this.db.query<{ p: number }>("SELECT pruned_up_to AS p FROM world_events_prune WHERE world_id = $1", [this.opts.worldId])).rows[0]?.p ?? 0; }

  async after(lastEventId: number, limit = 1000): Promise<StoredEvent[]> {
    const rows = (await this.db.query<{ event_id: number; world_version: number; type: string; drop_id: string | null; payload: WorldEvent; created_at: Date; instance_id: string | null }>("SELECT event_id, world_version, type, drop_id, payload, created_at, instance_id FROM world_events WHERE event_id > $1 ORDER BY event_id LIMIT $2", [lastEventId, limit])).rows;
    return rows.map((r) => ({ eventId: r.event_id, worldVersion: r.world_version, type: r.type, dropId: r.drop_id, payload: r.payload, createdAt: r.created_at.toISOString(), instanceId: r.instance_id }));
  }

  /** replay 가능 여부: 지운 경계 안쪽이면 이후 이벤트, 아니면 null (snapshot 으로 복구) */
  async replay(lastEventId: number, limit = 5000): Promise<StoredEvent[] | null> {
    if (lastEventId < await this.prunedUpTo()) return null;
    const out = await this.after(lastEventId, limit);
    this.metrics.replayed += out.length;
    return out;
  }

  /** retention (§20): 시간 또는 개수 초과분 중 retain=false 를 지운다. 지운 경계를 기록한다. */
  async prune(now = new Date()): Promise<number> {
    const cutoffTime = new Date(now.getTime() - this.opts.retentionHours * 3600_000);
    const byCount = (await this.db.query<{ id: number | null }>("SELECT event_id AS id FROM world_events ORDER BY event_id DESC OFFSET $1 LIMIT 1", [this.opts.retentionCount])).rows[0]?.id ?? 0;
    const byTime = (await this.db.query<{ id: number | null }>("SELECT MAX(event_id) AS id FROM world_events WHERE created_at < $1", [cutoffTime])).rows[0]?.id ?? 0;
    const upTo = Math.max(byCount, byTime);
    if (upTo <= 0) return 0;
    const r = await this.db.query("DELETE FROM world_events WHERE event_id <= $1 AND retain = false", [upTo]);
    await this.db.query("INSERT INTO world_events_prune (world_id, pruned_up_to, pruned_at) VALUES ($1, $2, now()) ON CONFLICT (world_id) DO UPDATE SET pruned_up_to = GREATEST(world_events_prune.pruned_up_to, EXCLUDED.pruned_up_to), pruned_at = now()", [this.opts.worldId, upTo]);
    this.metrics.pruned += r.rowCount ?? 0;
    return r.rowCount ?? 0;
  }
}
