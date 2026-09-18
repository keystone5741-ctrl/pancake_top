import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { WebSocketServer } from "ws";
import type { WorldApp } from "../app";
import { attachRealtime } from "../realtime/ws";

type Handler = (req: IncomingMessage, res: ServerResponse, params: Record<string, string>, url: URL) => Promise<void>;
interface Route { method: string; pattern: RegExp; keys: string[]; handler: Handler }

function json(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*", "cache-control": "no-store", ...extra });
  res.end(data);
}
async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

/** 최소 라우터. framework 없이 node:http (Phase 2 §4). */
export function createHttpServer(app: WorldApp): { server: Server; wss: WebSocketServer } {
  const routes: Route[] = [];
  const add = (method: string, path: string, handler: Handler): void => {
    const keys: string[] = [];
    const pattern = new RegExp("^" + path.replace(/:(\w+)/g, (_, k) => { keys.push(k); return "([^/]+)"; }) + "$");
    routes.push({ method, pattern, keys, handler });
  };

  add("GET", "/api/world", async (_req, res) => { json(res, 200, await app.snapshotEvent()); });
  add("GET", "/api/world/manifest", async (req, res) => { const m = await app.store.manifest(""); json(res, 200, m, { etag: `"v${m.version}"` }); void req; });
  add("GET", "/api/world/chunks/:id", async (req, res, p, url) => {
    const c = await app.store.chunkBytes(Number(p.id));
    if (!c) { json(res, 404, { error: "no such chunk" }); return; }
    const tag = `"${c.checksum.slice(0, 16)}"`;
    if (req.headers["if-none-match"] === tag) { res.writeHead(304); res.end(); return; }
    const immutable = c.finalized && url.searchParams.get("c") === c.checksum.slice(0, 16);
    res.writeHead(200, { "content-type": "application/octet-stream", "content-length": c.data.byteLength, etag: tag, "x-chunk-sha256": c.checksum, "access-control-allow-origin": "*", "access-control-expose-headers": "etag, x-chunk-sha256", "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache" });
    res.end(Buffer.from(c.data));
  });
  add("GET", "/api/drops/current", async (_req, res) => { json(res, 200, await app.currentDrop()); });
  add("GET", "/api/drops/:id", async (_req, res, p) => { const d = await app.getDrop(p.id); if (!d) json(res, 404, { error: "no such drop" }); else json(res, 200, d); });
  add("GET", "/api/pancakes/:serial", async (_req, res, p) => { const x = await app.pancake(Number(p.serial)); if (!x) json(res, 404, { error: "no such pancake" }); else json(res, 200, x); });
  if (app.cfg.devEndpoints) {
    add("POST", "/api/dev/purchase", async (req, res) => {
      const body = await readJson(req);
      try {
        const r = await app.purchase({ quantity: Number(body.quantity ?? 1), country: typeof body.country === "string" ? body.country : "ZZ", idempotencyKey: typeof body.idempotencyKey === "string" ? body.idempotencyKey : (req.headers["idempotency-key"] as string | undefined) ?? null });
        json(res, r.replayed ? 200 : 201, r);
      } catch (e) { json(res, 400, { error: String((e as Error).message) }); }
    });
    add("GET", "/api/dev/status", async (_req, res) => {
      const cur = await app.currentDrop();
      const jobs = (await app.db.query<{ status: string; n: number }>("SELECT status, COUNT(*)::int AS n FROM simulation_jobs GROUP BY status")).rows;
      json(res, 200, { world: app.store.worldState, currentDrop: cur, nextDrop: app.scheduler.after(app.scheduler.slotFor(cur.scheduled_at)), pending: app.pendingPancakes, worker: { alive: app.worker.alive, ready: app.worker.ready, crashes: app.worker.crashes, restarts: app.worker.restarts }, jobs, metrics: app.metricsSnapshot(), serverTime: app.clock().toISOString() });
    });
    add("GET", "/api/dev/metrics", async (_req, res) => { json(res, 200, app.metricsSnapshot()); });
    add("POST", "/api/dev/tick", async (req, res) => { const b = await readJson(req); await app.tick(b.now ? new Date(String(b.now)) : undefined); json(res, 200, { ok: true }); });
    add("POST", "/api/dev/worker/crash", async (_req, res) => { app.worker.devCrash(); json(res, 200, { ok: true }); });
    add("GET", "/dev", async (_req, res) => { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(DEV_HTML); });
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "OPTIONS") { res.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-methods": "GET,POST,OPTIONS", "access-control-allow-headers": "content-type, idempotency-key" }); res.end(); return; }
    for (const r of routes) {
      const m = r.pattern.exec(url.pathname);
      if (!m || r.method !== req.method) continue;
      const params: Record<string, string> = {};
      r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      try { await r.handler(req, res, params, url); } catch (e) { console.error("[http]", url.pathname, e); if (!res.headersSent) json(res, 500, { error: String((e as Error).message) }); }
      return;
    }
    json(res, 404, { error: "not found" });
  });
  const wss = attachRealtime(server, app);
  return { server, wss };
}

const DEV_HTML = `<!doctype html><meta charset="utf-8"><title>PANCAKE DROP dev</title>
<style>body{font:13px ui-monospace,monospace;background:#0d0f14;color:#e8e6e1;padding:16px}pre{background:#151821;padding:12px;border-radius:8px;white-space:pre-wrap}button{background:#f6c453;border:0;border-radius:6px;padding:6px 10px;font:inherit;font-weight:700;cursor:pointer;margin-right:6px}</style>
<h2>PANCAKE DROP — world-server dev</h2>
<div><button onclick="buy(1)">BUY 1</button><button onclick="buy(10)">BUY 10</button><button onclick="buy(100)">BUY 100</button><button onclick="fetch('/api/dev/worker/crash',{method:'POST'})">CRASH WORKER</button></div>
<h3>status</h3><pre id="s">…</pre><h3>events</h3><pre id="e"></pre>
<script>
async function refresh(){const r=await fetch('/api/dev/status');document.getElementById('s').textContent=JSON.stringify(await r.json(),null,1)}
async function buy(q){await fetch('/api/dev/purchase',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({quantity:q,country:'KR'})});refresh()}
const ws=new WebSocket((location.protocol==='https:'?'wss':'ws')+'://'+location.host+'/ws');ws.onmessage=(m)=>{const e=document.getElementById('e');e.textContent=(new Date().toISOString().slice(11,19)+' '+m.data+'\\n'+e.textContent).slice(0,6000)};
refresh();setInterval(refresh,2000);
</script>`;
