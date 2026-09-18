import { createHash, createHmac } from "node:crypto";
import { mkdir, readFile, rename, writeFile, readdir, unlink, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * Chunk 객체 저장소 (Phase 2 §16, Phase 3A §8~§12).
 * DB(chunks.data) 가 authoritative 이고 여기는 서빙/CDN 용 복사본이다. 키는 S3 스타일 경로:
 *   immutable: worlds/<world>/chunks/000123-v45.chunk
 *   staging  : worlds/<world>/staging/000123-v46.chunk   (mutable 현재 chunk; 커밋 후 finalized 면 chunks/ 로 승격)
 * 구현: LocalChunkStorage(파일), ObjectChunkStorage(S3 호환 HTTP, SDK 없음), MemoryChunkStorage(테스트).
 */
export interface StoredObjectInfo { size: number; etag: string | null; sha256: string | null; lastModified: Date | null }
export interface PutOptions { sha256?: string; contentType?: string }

export interface ChunkStorage {
  put(key: string, data: Uint8Array, opts?: PutOptions): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
  exists(key: string): Promise<boolean>;
  head(key: string): Promise<StoredObjectInfo | null>;
  delete(key: string): Promise<void>;
  /** prefix 아래 키 목록 (정렬) */
  list(prefix: string): Promise<string[]>;
  /** 같은 저장소 안 복사 (승격). 기본 구현은 get+put. */
  copy(from: string, to: string): Promise<void>;
}

export const pad6 = (id: number): string => String(id).padStart(6, "0");
export const chunkKey = (world: string, id: number, version: number): string => `worlds/${world}/chunks/${pad6(id)}-v${version}.chunk`;
export const stagingKey = (world: string, id: number, version: number): string => `worlds/${world}/staging/${pad6(id)}-v${version}.chunk`;
export const worldPrefix = (world: string): string => `worlds/${world}/`;
export const isStagingKey = (key: string): boolean => key.includes("/staging/");
export const md5Hex = (b: Uint8Array): string => createHash("md5").update(b).digest("hex");

abstract class BaseStorage implements ChunkStorage {
  abstract put(key: string, data: Uint8Array, opts?: PutOptions): Promise<void>;
  abstract get(key: string): Promise<Uint8Array | null>;
  abstract head(key: string): Promise<StoredObjectInfo | null>;
  abstract delete(key: string): Promise<void>;
  abstract list(prefix: string): Promise<string[]>;
  async exists(key: string): Promise<boolean> { return (await this.head(key)) !== null; }
  async copy(from: string, to: string): Promise<void> { const b = await this.get(from); if (!b) throw new Error(`copy: missing ${from}`); const h = await this.head(from); await this.put(to, b, { sha256: h?.sha256 ?? undefined }); }
}

// ---------------------------------------------------------------- local filesystem
export class LocalChunkStorage extends BaseStorage {
  constructor(readonly dir: string) { super(); }
  private path(key: string): string { if (key.includes("..")) throw new Error("bad key"); return join(this.dir, key); }
  async put(key: string, data: Uint8Array, opts: PutOptions = {}): Promise<void> {
    const p = this.path(key);
    await mkdir(dirname(p), { recursive: true });
    const tmp = p + ".tmp";
    await writeFile(tmp, data);
    if (opts.sha256) await writeFile(p + ".sha256", opts.sha256);
    await rename(tmp, p); // atomic replace
  }
  async get(key: string): Promise<Uint8Array | null> {
    try { return new Uint8Array(await readFile(this.path(key))); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
  }
  async head(key: string): Promise<StoredObjectInfo | null> {
    try { const s = await stat(this.path(key)); let sha: string | null = null; try { sha = (await readFile(this.path(key) + ".sha256", "utf8")).trim(); } catch { /* none */ } return { size: s.size, etag: null, sha256: sha, lastModified: s.mtime }; } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
  }
  async delete(key: string): Promise<void> { for (const p of [this.path(key), this.path(key) + ".sha256"]) { try { await unlink(p); } catch { /* ignore */ } } }
  async list(prefix: string): Promise<string[]> {
    const out: string[] = [];
    const walk = async (rel: string): Promise<void> => {
      let entries; try { entries = await readdir(join(this.dir, rel), { withFileTypes: true }); } catch { return; }
      for (const e of entries) { const r = rel ? `${rel}/${e.name}` : e.name; if (e.isDirectory()) await walk(r); else if (r.startsWith(prefix) && !r.endsWith(".tmp") && !r.endsWith(".sha256")) out.push(r); }
    };
    await walk("");
    return out.sort();
  }
}

// ---------------------------------------------------------------- in-memory (tests)
export class MemoryChunkStorage extends BaseStorage {
  readonly files = new Map<string, { data: Uint8Array; sha256: string | null; at: Date }>();
  failNextPut = false;
  /** 테스트용: 다음 head() 에서 크기를 틀리게 보고한다 (verify 실패 유도) */
  corruptNextHead = false;
  async put(key: string, data: Uint8Array, opts: PutOptions = {}): Promise<void> { if (this.failNextPut) { this.failNextPut = false; throw new Error("injected storage failure"); } this.files.set(key, { data: new Uint8Array(data), sha256: opts.sha256 ?? null, at: new Date() }); }
  async get(key: string): Promise<Uint8Array | null> { return this.files.get(key)?.data ?? null; }
  async head(key: string): Promise<StoredObjectInfo | null> { const f = this.files.get(key); if (!f) return null; const corrupt = this.corruptNextHead; this.corruptNextHead = false; return { size: corrupt ? f.data.byteLength + 1 : f.data.byteLength, etag: md5Hex(f.data), sha256: f.sha256, lastModified: f.at }; }
  async delete(key: string): Promise<void> { this.files.delete(key); }
  async list(prefix: string): Promise<string[]> { return [...this.files.keys()].filter((k) => k.startsWith(prefix)).sort(); }
}

// ---------------------------------------------------------------- S3-compatible object storage (AWS SigV4, SDK 없음)
export interface ObjectStorageConfig { endpoint: string; bucket: string; region: string; accessKeyId: string; secretAccessKey: string; /** 모든 키 앞에 붙는 prefix (예: "prod/") */ prefix?: string; /** path-style (endpoint/bucket/key). R2/MinIO 기본. */ forcePathStyle?: boolean; maxRetries?: number }

export class ObjectStorageError extends Error { constructor(readonly status: number, readonly method: string, readonly key: string, body: string) { super(`${method} ${key}: HTTP ${status} ${body.slice(0, 200)}`); } }

export class ObjectChunkStorage extends BaseStorage {
  readonly cfg: Required<ObjectStorageConfig>;
  metrics = { requests: 0, retries: 0, bytesUp: 0, bytesDown: 0, msTotal: 0 };
  constructor(cfg: ObjectStorageConfig) { super(); this.cfg = { prefix: "", forcePathStyle: true, maxRetries: 3, ...cfg }; }

  private url(key: string, query = "", bucketRoot = false): { url: URL; canonicalUri: string } {
    const e = new URL(this.cfg.endpoint);
    const full = bucketRoot ? "" : this.cfg.prefix + key;
    const enc = full.split("/").map((s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase())).join("/");
    const uri = this.cfg.forcePathStyle ? `/${this.cfg.bucket}${full ? "/" + enc : ""}` : `/${enc}`;
    const host = this.cfg.forcePathStyle ? e.host : `${this.cfg.bucket}.${e.host}`;
    const url = new URL(`${e.protocol}//${host}${uri}${query ? "?" + query : ""}`);
    return { url, canonicalUri: uri };
  }

  /** 서명된 요청. 5xx / 네트워크 오류는 재시도, 4xx 는 즉시 실패. */
  private async request(method: string, key: string, opts: { body?: Uint8Array; headers?: Record<string, string>; query?: string; bucketRoot?: boolean } = {}): Promise<{ status: number; headers: Headers; body: Uint8Array }> {
    const { url, canonicalUri } = this.url(key, opts.query, opts.bucketRoot);
    const body = opts.body ?? new Uint8Array(0);
    const payloadHash = createHash("sha256").update(body).digest("hex");
    const now = new Date();
    const amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
    const date = amzDate.slice(0, 8);
    const headers: Record<string, string> = { host: url.host, "x-amz-content-sha256": payloadHash, "x-amz-date": amzDate, ...(opts.headers ?? {}) };
    const signedNames = Object.keys(headers).map((h) => h.toLowerCase()).sort();
    const canonicalHeaders = signedNames.map((h) => `${h}:${String(headers[h] ?? headers[Object.keys(headers).find((k) => k.toLowerCase() === h)!]).trim().replace(/\s+/g, " ")}\n`).join("");
    const canonicalQuery = [...url.searchParams.entries()].map(([k, v]) => [encodeURIComponent(k), encodeURIComponent(v)] as const).sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0).map(([k, v]) => `${k}=${v}`).join("&");
    const canonicalRequest = [method, canonicalUri, canonicalQuery, canonicalHeaders, signedNames.join(";"), payloadHash].join("\n");
    const scope = `${date}/${this.cfg.region}/s3/aws4_request`;
    const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, createHash("sha256").update(canonicalRequest).digest("hex")].join("\n");
    const kDate = createHmac("sha256", "AWS4" + this.cfg.secretAccessKey).update(date).digest();
    const kRegion = createHmac("sha256", kDate).update(this.cfg.region).digest();
    const kService = createHmac("sha256", kRegion).update("s3").digest();
    const kSigning = createHmac("sha256", kService).update("aws4_request").digest();
    const signature = createHmac("sha256", kSigning).update(stringToSign).digest("hex");
    const authorization = `AWS4-HMAC-SHA256 Credential=${this.cfg.accessKeyId}/${scope}, SignedHeaders=${signedNames.join(";")}, Signature=${signature}`;
    const { host: _h, ...sendHeaders } = headers;
    let attempt = 0;
    for (;;) {
      const t0 = performance.now();
      this.metrics.requests++;
      try {
        const res = await fetch(url, { method, headers: { ...sendHeaders, authorization }, body: method === "PUT" || method === "POST" ? body : undefined });
        const out = new Uint8Array(await res.arrayBuffer());
        this.metrics.msTotal += performance.now() - t0;
        if (res.status >= 500 && attempt < this.cfg.maxRetries) { attempt++; this.metrics.retries++; await new Promise((r) => setTimeout(r, 100 * 2 ** attempt)); continue; }
        if (method === "PUT") this.metrics.bytesUp += body.byteLength; else this.metrics.bytesDown += out.byteLength;
        return { status: res.status, headers: res.headers, body: out };
      } catch (e) {
        this.metrics.msTotal += performance.now() - t0;
        if (attempt < this.cfg.maxRetries) { attempt++; this.metrics.retries++; await new Promise((r) => setTimeout(r, 100 * 2 ** attempt)); continue; }
        throw e;
      }
    }
  }

  async put(key: string, data: Uint8Array, opts: PutOptions = {}): Promise<void> {
    const headers: Record<string, string> = { "content-type": opts.contentType ?? "application/octet-stream", "content-length": String(data.byteLength) };
    if (opts.sha256) headers["x-amz-meta-sha256"] = opts.sha256;
    const r = await this.request("PUT", key, { body: data, headers });
    if (r.status !== 200) throw new ObjectStorageError(r.status, "PUT", key, Buffer.from(r.body).toString("utf8"));
  }
  async get(key: string): Promise<Uint8Array | null> {
    const r = await this.request("GET", key);
    if (r.status === 404) return null;
    if (r.status !== 200) throw new ObjectStorageError(r.status, "GET", key, Buffer.from(r.body).toString("utf8"));
    return r.body;
  }
  async head(key: string): Promise<StoredObjectInfo | null> {
    const r = await this.request("HEAD", key);
    if (r.status === 404) return null;
    if (r.status !== 200) throw new ObjectStorageError(r.status, "HEAD", key, "");
    const lm = r.headers.get("last-modified");
    return { size: Number(r.headers.get("content-length") ?? 0), etag: (r.headers.get("etag") ?? "").replace(/"/g, "") || null, sha256: r.headers.get("x-amz-meta-sha256"), lastModified: lm ? new Date(lm) : null };
  }
  async delete(key: string): Promise<void> {
    const r = await this.request("DELETE", key);
    if (r.status !== 204 && r.status !== 200 && r.status !== 404) throw new ObjectStorageError(r.status, "DELETE", key, Buffer.from(r.body).toString("utf8"));
  }
  async list(prefix: string): Promise<string[]> {
    const out: string[] = [];
    let token: string | null = null;
    do {
      const q = `list-type=2&prefix=${encodeURIComponent(this.cfg.prefix + prefix)}&max-keys=1000` + (token ? `&continuation-token=${encodeURIComponent(token)}` : "");
      const r = await this.request("GET", "", { query: q, bucketRoot: true });
      if (r.status !== 200) throw new ObjectStorageError(r.status, "LIST", prefix, Buffer.from(r.body).toString("utf8"));
      const xml = Buffer.from(r.body).toString("utf8");
      for (const m of xml.matchAll(/<Key>([^<]+)<\/Key>/g)) out.push(decodeXml(m[1]).slice(this.cfg.prefix.length));
      const next = /<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(xml);
      token = /<IsTruncated>true<\/IsTruncated>/.test(xml) && next ? decodeXml(next[1]) : null;
    } while (token);
    return out.sort();
  }
  async copy(from: string, to: string): Promise<void> {
    const src = `/${this.cfg.bucket}/${(this.cfg.prefix + from).split("/").map(encodeURIComponent).join("/")}`;
    const r = await this.request("PUT", to, { headers: { "x-amz-copy-source": src, "x-amz-metadata-directive": "COPY" } });
    if (r.status !== 200) throw new ObjectStorageError(r.status, "COPY", to, Buffer.from(r.body).toString("utf8"));
  }
}

function decodeXml(s: string): string { return s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"); }

/** 설정으로 저장소를 고른다 (Phase 3A §9: vendor 는 환경변수만으로 바꾼다) */
export function createChunkStorage(cfg: { storageKind: string; dataDir: string; s3Endpoint: string; s3Bucket: string; s3Region: string; s3AccessKeyId: string; s3SecretAccessKey: string; s3Prefix: string; s3ForcePathStyle: boolean }): ChunkStorage {
  if (cfg.storageKind === "object") {
    if (!cfg.s3Endpoint || !cfg.s3Bucket) throw new Error("STORAGE_KIND=object needs S3_ENDPOINT and S3_BUCKET");
    return new ObjectChunkStorage({ endpoint: cfg.s3Endpoint, bucket: cfg.s3Bucket, region: cfg.s3Region, accessKeyId: cfg.s3AccessKeyId, secretAccessKey: cfg.s3SecretAccessKey, prefix: cfg.s3Prefix, forcePathStyle: cfg.s3ForcePathStyle });
  }
  return new LocalChunkStorage(join(cfg.dataDir, "storage"));
}
