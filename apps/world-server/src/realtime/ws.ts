import type { Server } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import type { WorldApp } from "../app";

/**
 * WebSocket realtime (Phase 2 §31~§33). 접속 시 world.snapshot 을 보내고 이후 이벤트를 broadcast 한다.
 * 재접속한 클라이언트는 snapshot 으로 복구한다 (누락 이벤트 replay 없음).
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
        const m = JSON.parse(String(raw)) as { type?: string };
        if (m.type === "resync") ws.send(JSON.stringify(await app.snapshotEvent()));
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
