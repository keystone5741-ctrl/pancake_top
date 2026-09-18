/**
 * Remote server mode (Phase 2 §41~§43): manifest → UrlChunkSource(캐시·체크섬) → Tower, WebSocket 으로 Drop 이벤트.
 * 서버 manifest 의 serial 은 UI 기준(1 부터)이라 엔진 id(0 부터)로 바꾼다.
 */
import { UrlChunkSource, type TowerManifest } from "tower-engine";

export interface ServerManifestChunk { id: number; startSerial: number; endSerial: number; count: number; minHeight: number; maxHeight: number; bounds: { min: [number, number, number]; max: [number, number, number] }; checksum: string; byteLength: number; finalized: boolean; url: string }
export interface ServerManifest { version: number; totalPancakes: number; allocatedPancakes: number; heightMeters: number; heightUnits: number; chunkSize: number; diameter: number; thickness: number; unitCm: number; chunks: ServerManifestChunk[] }

export function toTowerManifest(m: ServerManifest): TowerManifest & { version: number } {
  return {
    version: m.version as unknown as 1, // TowerManifest.version 은 포맷 버전, 여기서는 world version 을 실어 UrlChunkSource.version 으로 쓴다
    config: { chunkSize: m.chunkSize, diameter: m.diameter, thickness: m.thickness, unitCm: m.unitCm },
    totalCount: m.totalPancakes,
    headers: m.chunks.map((c) => ({ id: c.id, startSerial: c.startSerial - 1, endSerial: c.endSerial - 1, count: c.count, bounds: c.bounds, minHeight: c.minHeight, maxHeight: c.maxHeight, checksum: c.checksum })),
  };
}

export async function fetchManifest(server: string): Promise<ServerManifest> {
  const r = await fetch(`${server}/api/world/manifest`, { cache: "no-store" });
  if (!r.ok) throw new Error(`manifest ${r.status}`);
  return (await r.json()) as ServerManifest;
}

export function makeRemoteSource(server: string, m: ServerManifest): UrlChunkSource {
  const urls = new Map(m.chunks.map((c) => [c.id, c.url]));
  return new UrlChunkSource(toTowerManifest(m), (id) => `${server}${urls.get(id) ?? `/api/world/chunks/${id}`}`);
}

export interface RemoteEvents {
  onSnapshot?: (s: Record<string, unknown>) => void;
  onEvent?: (e: Record<string, unknown>) => void;
  onStatus?: (s: "connecting" | "open" | "closed") => void;
}

/** 자동 재접속 WebSocket. 재접속하면 서버가 world.snapshot 을 다시 보내 준다 (§33). */
export function connectRealtime(server: string, h: RemoteEvents): { close: () => void } {
  let ws: WebSocket | null = null;
  let closed = false;
  let delay = 500;
  const open = (): void => {
    if (closed) return;
    h.onStatus?.("connecting");
    ws = new WebSocket(server.replace(/^http/, "ws") + "/ws");
    ws.onopen = () => { delay = 500; h.onStatus?.("open"); };
    ws.onmessage = (m) => { const e = JSON.parse(String(m.data)) as Record<string, unknown>; if (e.type === "world.snapshot") h.onSnapshot?.(e); h.onEvent?.(e); };
    ws.onclose = () => { h.onStatus?.("closed"); if (!closed) setTimeout(open, delay); delay = Math.min(delay * 2, 10_000); };
    ws.onerror = () => { ws?.close(); };
  };
  open();
  return { close: () => { closed = true; ws?.close(); } };
}
