# Phase 2 — World Persistence

Phase 2 §11~§20, §34~§37. 스키마: `apps/world-server/src/db/schema.sql` (idempotent, `pnpm --filter world-server migrate`).

## 스키마

| 테이블 | 핵심 컬럼 | 뜻 |
| --- | --- | --- |
| `world_state` | `latest_global_serial`, `committed_serial`, `height_meters`, `height_units`, `latest_chunk_id`, `current_drop_id`, `version` | 월드 1행. `latest_global_serial` = 할당된 마지막 #N, `committed_serial` = transform 이 chunk 에 있는 마지막 #N. `version` 은 커밋마다 +1 |
| `drops` | `drop_id`, `scheduled_at`, `cutoff_at`, `status`, `start_serial`, `end_serial`, `pancake_count`, `height_before/after`, `simulation_started/finished_at`, `released_at` | Drop 생명주기 |
| `orders` | `order_id`, `idempotency_key UNIQUE`, `quantity`, `country`, `drop_id`, `start_serial`, `end_serial`, `status` | 구매 (가짜 결제) |
| `pancakes` | `pancake_id = global_serial`, `country`, `country_serial`, `drop_id`, `order_id`, `chunk_id`, `instance_index`, `variant`, `committed_at` | 팬케이크 1행. `UNIQUE (country, country_serial)`. `committed_at NULL` = 아직 시뮬레이션 전 |
| `chunks` | `chunk_id`, `start_serial`, `end_serial`, `count`, `min/max_height`, `bounds JSONB`, `checksum`(sha256), `byte_length`, `finalized`, `version`, `data BYTEA` | **authoritative chunk bytes**. 파일/CDN 은 여기서 파생 |
| `country_counters` | `country`, `latest_serial` | 국가별 serial |
| `simulation_jobs` | `job_id`, `drop_id`, `start_serial`, `end_serial`, `status`(RUNNING/DONE/RETRYABLE/FAILED), `attempt`, `seed`, `input_snapshot BYTEA`, `error` | job 1행 = worker 호출 1회. `input_snapshot` 은 시작 시점 표면(PKT1) |
| `world_snapshots` | `version`, `latest_serial`, `height_meters`, `surface_state BYTEA`, `last_completed_chunk`, `current_chunk` | 복구 지점 (§34) |

serial 은 BIGINT, `pg` 드라이버에서 number 로 파싱한다(2^53 안).

## Chunk (§16~§20)

- `.chunk` = tower-engine PKCH v1 (Phase 1). 헤더(id, startSerial, endSerial, count, min/max height, bounds) + transforms(stride 9: pos, quat, scale, thicknessScale) + attributes(variant u16, country u16).
- **append 전략**: chunk `k` 는 serial `k·CHUNK_SIZE+1 .. (k+1)·CHUNK_SIZE`. 가장 마지막 chunk 만 mutable(`finalized=false`), 가득 차면 finalized. 커밋마다 마지막 chunk 를 통째로 다시 인코딩해 덮어쓴다(10k 장 ≈ 380 KB, 평균 커밋 13 ms).
- **manifest** (`GET /api/world/manifest`): `version` + chunk 별 `checksum`, `byteLength`, `bounds`, `finalized`, `url`. url 에 checksum 앞 16자를 쿼리로 붙여 finalized chunk 는 `immutable` 캐시, mutable chunk 는 `no-cache` + etag.
- 클라이언트(`UrlChunkSource`)는 받은 bytes 의 sha256 을 manifest 와 비교한다. 불일치 시 1회 재요청(`retry=1`), 또 실패하면 `ChunkChecksumError`.
- `ChunkStorage` 인터페이스(put/get/list/remove) 뒤에 `LocalChunkStorage`(`DATA_DIR/tower/chunks/000123.chunk`, tmp+rename). S3/R2 는 같은 인터페이스로 붙인다(Phase 2 범위 밖).

## 원자적 커밋 순서 (§36)

`WorldStore.commit(job)`:

1. 메모리의 mutable chunk 에 job 결과를 이어 붙인다(가득 차면 새 chunk 시작).
2. 영향받은 chunk 를 인코딩 → sha256 → **파일 저장소에 먼저 쓴다**(tmp+rename).
3. **DB 트랜잭션** (하나): `world_state FOR UPDATE`(version 확인) → `chunks` upsert(bytes 포함, version+1) → `pancakes.committed_at` → `drops.height_after` → `simulation_jobs = DONE` → `world_state` (`committed_serial`, height, `latest_chunk_id`, `version+1`; `WHERE version = 이전`). 조건이 안 맞으면 전부 롤백.
4. 트랜잭션 성공 후에만 `world.updated` 이벤트.

트랜잭션 전 어느 단계에서 실패해도 이전 `version` 이 authoritative 다. 파일이 먼저 써졌을 수 있으므로 startup 의 `reconcileChunkFiles` 가 파일을 DB 로 되돌린다(없는 파일 복원, checksum 불일치 파일 덮어쓰기, DB 에 없는 파일 삭제).

commit / refresh / snapshot 은 store 내부 mutex 로 직렬화된다(§37 검증 중 발견: 커밋 도중 `refresh()` 가 stale 한 world_state 로 덮어쓰면 다음 커밋이 어긋난다 — `tests/concurrency.test.ts`).

## Snapshot (§34, §35)

`world_snapshots` 행 = version, latest serial, height, 표면 상위 512 장(PKT1), 마지막 완성 chunk id, 현재 chunk id. **Drop 이 READY 가 될 때 반드시**, 그리고 `SNAPSHOT_EVERY_PANCAKES`(10k) 마다. 복구는 snapshot 이 아니라 DB(chunks + world_state)가 기준이고, snapshot 은 표면 상태를 빨리 되살리는 용도다(§23: worker INIT 은 job 의 `input_snapshot` 을 쓴다).

## 크기 (1M 합성 월드, `bench/seed-synthetic.ts`)

| 항목 | 값 |
| --- | --- |
| chunk 100개 bytes | 40.0 MB (DB `chunks.data` + 파일 사본) |
| pancakes 1M 행 | DB 전체 270 MB (인덱스 포함) |
| seed 시간 | 10.2 s (1M 행 INSERT 8.7 s) |
| 서버 시작 | reconcile 100 파일 < 1 s |
