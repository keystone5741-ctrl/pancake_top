/** 서버 설정. 값은 환경변수로 바꾼다 (Phase 2 §28: cutoff 를 hardcode 하지 않는다). */
export interface ServerConfig {
  databaseUrl: string;
  port: number;
  dataDir: string;
  worldId: string;
  dropIntervalSeconds: number;
  dropCutoffSeconds: number;
  chunkSize: number;
  simBatchSize: number;
  simBatchWindowMs: number;
  snapshotEveryPancakes: number;
  workerMaxAttempts: number;
  queueThrottleMs: number;
  surfaceTopN: number;
  /** worker 에 넘기는 base surface 크기 (높이맵·콜라이더용 상위 K 장) */
  surfaceSliceSize: number;
  devEndpoints: boolean;
  /** 저장소 종류: local | object (S3 호환) */
  storageKind: string;
  s3Endpoint: string; s3Bucket: string; s3Region: string; s3AccessKeyId: string; s3SecretAccessKey: string; s3Prefix: string; s3ForcePathStyle: boolean;
  /** 관리 API 비밀 헤더 값 (x-admin-secret). 비어 있으면 관리 API 비활성 */
  adminSecret: string;
  /** 이벤트 로그 보존: 시간 / 최대 개수 (감사 이벤트 제외) */
  eventRetentionHours: number; eventRetentionCount: number;
  /** 영구 보존할 이벤트 type (쉼표 구분) */
  eventAuditTypes: string[];
  /** 인스턴스 식별자 (leader 표시용) */
  instanceId: string;
  /** leader lease 갱신 주기 / 만료 (ms) */
  leaderLeaseMs: number;
  /** job lease 만료 (ms): 이 시간 안에 갱신되지 않은 RUNNING job 은 다른 인스턴스가 회수 */
  jobLeaseMs: number;
  /** 커밋 파이프라인: 물리와 chunk 인코딩/커밋을 겹친다 */
  pipelineOverlap: boolean;
}

const env = (k: string, d: string): string => process.env[k] ?? d;
const num = (k: string, d: number): number => { const v = process.env[k]; return v === undefined || v === "" ? d : Number(v); };

export function loadConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    databaseUrl: env("DATABASE_URL", "postgres://pancake:pancake@127.0.0.1:5432/pancake_world"),
    port: num("PORT", 8787),
    dataDir: env("DATA_DIR", "./data"),
    worldId: env("WORLD_ID", "world"),
    dropIntervalSeconds: num("DROP_INTERVAL_SECONDS", 600),
    dropCutoffSeconds: num("DROP_CUTOFF_SECONDS", 60),
    chunkSize: num("CHUNK_SIZE", 10_000),
    simBatchSize: num("SIM_BATCH_SIZE", 100),
    simBatchWindowMs: num("SIM_BATCH_WINDOW_MS", 250),
    snapshotEveryPancakes: num("SNAPSHOT_EVERY_PANCAKES", 10_000),
    workerMaxAttempts: num("WORKER_MAX_ATTEMPTS", 3),
    queueThrottleMs: num("QUEUE_THROTTLE_MS", 500),
    surfaceTopN: num("SURFACE_TOP_N", 64),
    surfaceSliceSize: num("SURFACE_SLICE_SIZE", 512),
    devEndpoints: env("DEV_ENDPOINTS", "1") === "1",
    storageKind: env("STORAGE_KIND", "local"),
    s3Endpoint: env("S3_ENDPOINT", ""), s3Bucket: env("S3_BUCKET", ""), s3Region: env("S3_REGION", "auto"), s3AccessKeyId: env("S3_ACCESS_KEY_ID", ""), s3SecretAccessKey: env("S3_SECRET_ACCESS_KEY", ""), s3Prefix: env("S3_PREFIX", ""), s3ForcePathStyle: env("S3_FORCE_PATH_STYLE", "1") === "1",
    adminSecret: env("ADMIN_SECRET", "dev-admin"),
    eventRetentionHours: num("EVENT_RETENTION_HOURS", 24), eventRetentionCount: num("EVENT_RETENTION_COUNT", 100_000),
    eventAuditTypes: env("EVENT_AUDIT_TYPES", "drop.released,drop.failed,drop.aborted,drop.recovered,simulation.failed").split(",").map((s) => s.trim()).filter(Boolean),
    instanceId: env("INSTANCE_ID", `${process.env.HOSTNAME ?? "srv"}-${process.pid}`),
    leaderLeaseMs: num("LEADER_LEASE_MS", 5000),
    jobLeaseMs: num("JOB_LEASE_MS", 60_000),
    pipelineOverlap: env("PIPELINE_OVERLAP", "1") === "1",
    ...overrides,
  };
}
