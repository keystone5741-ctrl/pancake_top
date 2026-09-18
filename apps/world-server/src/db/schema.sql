-- PANCAKE DROP Phase 2 schema (§11~§15, §25, §34). 모두 idempotent.

CREATE TABLE IF NOT EXISTS world_state (
  world_id              TEXT PRIMARY KEY,
  latest_global_serial  BIGINT NOT NULL DEFAULT 0,      -- 할당된 마지막 global serial (UI #N, 1 부터)
  committed_serial      BIGINT NOT NULL DEFAULT 0,      -- transform 이 chunk 에 커밋된 마지막 serial
  height_meters         DOUBLE PRECISION NOT NULL DEFAULT 0,
  height_units          DOUBLE PRECISION NOT NULL DEFAULT 0,
  latest_chunk_id       INTEGER NOT NULL DEFAULT -1,
  current_drop_id       TEXT,
  version               BIGINT NOT NULL DEFAULT 0,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS drops (
  drop_id                 TEXT PRIMARY KEY,
  scheduled_at            TIMESTAMPTZ NOT NULL,
  cutoff_at               TIMESTAMPTZ NOT NULL,
  status                  TEXT NOT NULL,
  start_serial            BIGINT,
  end_serial              BIGINT,
  pancake_count           INTEGER NOT NULL DEFAULT 0,
  height_before           DOUBLE PRECISION,
  height_after            DOUBLE PRECISION,
  simulation_started_at   TIMESTAMPTZ,
  simulation_finished_at  TIMESTAMPTZ,
  released_at             TIMESTAMPTZ,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS orders (
  order_id         TEXT PRIMARY KEY,
  idempotency_key  TEXT UNIQUE,
  quantity         INTEGER NOT NULL,
  country          TEXT NOT NULL,
  drop_id          TEXT NOT NULL REFERENCES drops(drop_id),
  start_serial     BIGINT NOT NULL,
  end_serial       BIGINT NOT NULL,
  status           TEXT NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pancakes (
  pancake_id      BIGINT PRIMARY KEY,                  -- = global_serial
  global_serial   BIGINT NOT NULL UNIQUE,
  country         TEXT NOT NULL,
  country_serial  BIGINT NOT NULL,
  drop_id         TEXT NOT NULL,
  order_id        TEXT NOT NULL,
  chunk_id        INTEGER NOT NULL,
  instance_index  INTEGER NOT NULL,
  variant         INTEGER NOT NULL DEFAULT 0,
  committed_at    TIMESTAMPTZ,                          -- transform 커밋 시각 (NULL = 아직 시뮬레이션 전)
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (country, country_serial)
);
CREATE INDEX IF NOT EXISTS pancakes_drop_idx ON pancakes(drop_id);
CREATE INDEX IF NOT EXISTS pancakes_chunk_idx ON pancakes(chunk_id);

CREATE TABLE IF NOT EXISTS chunks (
  chunk_id      INTEGER PRIMARY KEY,
  start_serial  BIGINT NOT NULL,
  end_serial    BIGINT NOT NULL,
  count         INTEGER NOT NULL,
  min_height    DOUBLE PRECISION NOT NULL,
  max_height    DOUBLE PRECISION NOT NULL,
  checksum      TEXT NOT NULL,
  byte_length   INTEGER NOT NULL,
  finalized     BOOLEAN NOT NULL DEFAULT false,
  version       BIGINT NOT NULL,
  data          BYTEA NOT NULL,                        -- authoritative chunk bytes (.chunk). 파일/CDN 은 여기서 파생
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS country_counters (
  country        TEXT PRIMARY KEY,
  latest_serial  BIGINT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS simulation_jobs (
  job_id          TEXT PRIMARY KEY,
  drop_id         TEXT NOT NULL,
  start_serial    BIGINT NOT NULL,
  end_serial      BIGINT NOT NULL,
  status          TEXT NOT NULL,                        -- PENDING | RUNNING | DONE | RETRYABLE | FAILED
  attempt         INTEGER NOT NULL DEFAULT 0,
  seed            INTEGER NOT NULL,
  input_snapshot  BYTEA,                                -- job 시작 시점의 surface 상태 (PKT1)
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at      TIMESTAMPTZ,
  finished_at     TIMESTAMPTZ,
  error           TEXT
);
CREATE INDEX IF NOT EXISTS simulation_jobs_status_idx ON simulation_jobs(status);

CREATE TABLE IF NOT EXISTS world_snapshots (
  snapshot_id          BIGSERIAL PRIMARY KEY,
  version              BIGINT NOT NULL,
  latest_serial        BIGINT NOT NULL,
  height_meters        DOUBLE PRECISION NOT NULL,
  surface_state        BYTEA NOT NULL,                  -- PKT1: 상위 K 장
  last_completed_chunk INTEGER NOT NULL,
  current_chunk        INTEGER NOT NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 이전 스키마에서 올라오는 경우를 위한 추가 컬럼 (idempotent)
ALTER TABLE chunks ADD COLUMN IF NOT EXISTS data BYTEA NOT NULL DEFAULT ''::bytea;
