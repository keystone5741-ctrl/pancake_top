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
    ...overrides,
  };
}
