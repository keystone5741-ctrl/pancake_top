# Phase 3A — Operations

Phase 3A §14~§16, §26~§28.

## Health (§27)

| 경로 | 뜻 |
| --- | --- |
| `GET /health/live` | 프로세스 살아 있음 (200) |
| `GET /health/ready` | DB `SELECT 1`, 저장소 `list(worlds/<world>/chunks/)`, leader 면 파이프라인이 halted 가 아님 → 200, 아니면 503 + `checks` |

로드밸런서는 `ready` 로 라우팅하고, `live` 로 재시작 판단.

## Metrics (§26) — `GET /api/metrics` (또는 `/api/dev/metrics`)

instanceId · leader · leaderTerm · pipelineHalted · worldTotal · worldCommitted · worldVersion · purchaseEventsPerSec · pendingSimulationPancakes · simulationThroughputPerSec · simulationJobP50/P95Ms · workerCrashes · workerRestarts · jobRetries · jobsFailed · recoveries · overlappedCommits · discardedResults · claimConflicts · dbQueries · dbLatencyP50/P95Ms · chunkEncodeMsAvg · storageUploadMsAvg · storageVerifyMsAvg · dbTxMsAvg · commitMsAvg · promotions · storage{requests, retries, bytesUp/Down, msTotal} · manifestMs · snapshots · recoveredFiles · events{appended, delivered, replayed, pruned, lagMsLast/Max} · websocketClients · lastJob(물리 지표).

Prometheus 노출은 이 JSON 을 그대로 변환하면 된다(범위 밖).

## Structured logging (§28)

`src/log.ts`: 한 줄 JSON. 필수 `timestamp, level, service, event`; 있으면 `dropId, jobId, worldVersion, duration`. `LOG_LEVEL=debug|info|warn|error`. 주요 event: `server.listening`, `leader.changed`, `drop.transition`, `job.committed`, `job.commit_failed`, `simulation.failed`, `drop.failed`, `drop.recovered`, `drop.aborted`, `jobs.reclaimed`, `events.append`, `http.error`. 민감정보 없음(주문·결제 데이터 없음).

## FAILED Drop (§15~§16)

job 이 재시도 예산(`WORKER_MAX_ATTEMPTS` × (manual_retries + 1), 기본 3)을 넘기면 job FAILED → Drop FAILED(`failure_reason`, `failure_error`) → `drop.failed` 이벤트 → **파이프라인 halted** (`/health/ready` 503). 뒤의 팬케이크는 serial 순서 때문에 함께 멈춘다.

| failure_reason | 뜻 | 보통의 조치 |
| --- | --- | --- |
| `WORKER_CRASH` | worker 프로세스 exit ≠ 0 (Rapier 패닉, OOM) | retry (같은 입력이면 재현될 수 있음 → 물리 이슈면 abort 로 다음 Drop 에 넘기고 조사) |
| `SIMULATION_FAILED` | worker 가 ERROR 응답 (capacity, 초기화, timeout) | retry / recover |
| `STORAGE_FAILED` | 업로드 또는 HEAD 실패 | 저장소 복구 후 retry |
| `DB_COMMIT_FAILED` | 트랜잭션 실패 (version 충돌, 교착, 연결) | retry |
| `CORRUPTED_CHUNK` | 업로드 검증 불일치 (size/sha/etag) | 저장소 점검 후 recover |
| `UNKNOWN` | 그 밖 | 로그 확인 |

모든 시도는 `simulation_attempts` 에 남는다(retry 해도 지우지 않는다).

## Admin API (§14) — 헤더 `x-admin-secret: $ADMIN_SECRET` (기본 `dev-admin`; 실제 인증은 이후 Phase)

| 메서드 | 경로 | 동작 |
| --- | --- | --- |
| GET | `/api/admin/drops/failed` | FAILED Drop + 실패 job + 시도 기록, `pipelineHalted`, `leader` |
| POST | `/api/admin/drops/:id/retry` | FAILED job → RETRYABLE(같은 input snapshot, manual_retries+1 → 예산 3회 추가), Drop → FINALIZING, 파이프라인 재개 |
| POST | `/api/admin/drops/:id/recover` | retry 와 같되 job 의 input snapshot 을 버리고 저장소 reconcile 후 DB 표면으로 worker 를 다시 INIT (CORRUPTED_CHUNK, 저장소 사고 뒤) |
| POST | `/api/admin/drops/:id/abort` | 이 Drop 의 미커밋 팬케이크를 **현재 Drop 으로 옮긴다**(serial 그대로, 국가 serial 그대로). 실패 job 도 옮겨져 다음 Drop 에서 다시 시뮬레이션. Drop 은 FAILED 로 남고 `aborted_at` 기록. 이 Drop 시각에 "공개할 것" 이 없어지는 것이지 팬케이크를 잃지 않는다 |
| GET | `/api/admin/jobs/:id/attempts` | 시도 기록 |

이벤트: `drop.recovered{mode}`, `drop.aborted{movedPancakes,toDropId}` (감사 보존).

운영 절차: `/api/admin/drops/failed` → `failure_reason` 과 attempts 의 error 확인 → 원인 해결 → retry/recover → `/health/ready` 200 확인 → `drop.ready`/`released` 이벤트 확인. 같은 이유로 3번 더 실패하면 다시 FAILED (무한 재시도 없음).

## 배포 메모

- 인스턴스 ≥ 2, 같은 PostgreSQL, 같은 저장소 설정. leader 는 자동.
- 롤링 재시작: follower 부터. leader 를 내리면 다음 인스턴스가 ≤ `LEADER_LEASE_MS` 안에 잡고, in-flight job 은 `JOB_LEASE_MS` 뒤 회수된다(짧게 두려면 5~10 s).
- `STORAGE_KIND=object` 전환: 서버를 새 설정으로 재시작하면 startup reconcile 이 DB bytes 로 저장소를 채운다(1M ≈ 100 객체).
