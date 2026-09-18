import type { Server } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import type { WorldApp } from "../app";

/**
 * WebSocket realtime (Phase 2 §31~§33, Phase 3A §19). 접속 시 world.snapshot(lastEventId 포함)을 보내고 이후 이벤트를 broadcast 한다.
 * 재접속: { type: "resync", lastEventId } → retention 안이면 그 이후 이벤트를 순서대로 replay 하고 resync.done, 밖이면 world.snapshot.
 * 이벤트는 world_events 에서 오므로 (event_id 순서) 다른 인스턴스가 만든 것도 여기서 나간다.
 */
export function attachRealtime(server: Server, app: WorldApp): WebSocketServer {
  const wss = new WebSocketServer({ server, path: "/ws" });
  const clients = new Set<WebSocket>();
  wss.on("connection", async (ws) => {
    clients.add(ws);
    app.metrics.wsClients = clients.size;
    ws.on("close", () => { clients.delete(ws); app.metrics.wsClients = clients.size; });
    ws.on("message", async (raw) => {
      try {
        const m = JSON.parse(String(raw)) as { type?: string; lastEventId?: number };
        if (m.type === "resync") {
          const last = Number(m.lastEventId ?? -1);
          const replay = last >= 0 ? await app.eventLog.replay(last) : null;
          if (replay) { for (const e of replay) ws.send(JSON.stringify({ ...(e.payload as object), eventId: e.eventId })); ws.send(JSON.stringify({ type: "resync.done", lastEventId: replay.length ? replay[replay.length - 1].eventId : last, replayed: replay.length })); }
          else ws.send(JSON.stringify(await app.snapshotEvent()));
        }
        if (m.type === "ping") ws.send(JSON.stringify({ type: "pong", serverTime: app.clock().toISOString() }));
      } catch { /* ignore */ }
    });
    try { ws.send(JSON.stringify(await app.snapshotEvent())); } catch { /* ignore */ }
  });
  app.events.onEvent((e) => {
    const data = JSON.stringify(e);
    for (const c of clients) if (c.readyState === c.OPEN) c.send(data);
  });
  return wss;
}
