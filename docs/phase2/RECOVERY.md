# Phase 2 — Recovery

Phase 2 §21~§25, §37. 원칙: **DB 가 authoritative**, worker 는 언제든 죽어도 되고, 재시도는 유한하다.

## 실패 지점별 동작

| 시점 | 무엇이 남나 | 복구 |
| --- | --- | --- |
| 구매 트랜잭션 중 crash | 아무것도 (롤백) | 클라이언트가 같은 `idempotencyKey` 로 재요청하면 새로 할당하거나 기존 주문 replay |
| worker 가 SIMULATE 중 crash (`exit ≠ 0`) | job = RUNNING, 파일/DB 변화 없음 | `WorkerCrashError` → job RETRYABLE(`error` 기록) → 다음 루프에서 같은 범위·같은 seed 로 `attempt+1`, worker 를 job 의 `input_snapshot`(시작 시점 표면)으로 새로 INIT |
| chunk 파일 쓰기 실패 | 일부 파일만 새 내용 | commit 예외 → job RETRYABLE, `store.refresh()` 로 메모리 상태 되돌림. 재시도 커밋이 파일을 다시 쓴다 |
| DB 트랜잭션 실패 (교착, version 충돌) | 파일은 새 내용, DB 는 이전 version | 위와 같음. 이전 version 이 authoritative |
| 서버 프로세스 crash (커밋 전) | 파일이 DB 보다 앞설 수 있음 | startup `reconcileChunkFiles`: DB 의 chunk bytes/checksum 으로 파일을 되돌리고, DB 에 없는 파일 삭제 |
| 서버 프로세스 crash (커밋 후) | 일관된 상태 | startup 에서 `committed_serial < latest_global_serial` 이면 파이프라인이 이어서 시뮬레이션. RUNNING 이던 job 은 RETRYABLE 로 |
| 재시도 상한(`WORKER_MAX_ATTEMPTS`=3) 초과 | job FAILED | Drop → FAILED, `drop.failed` 이벤트, **파이프라인 정지**(무한 재시도 금지). 운영자가 원인을 고친 뒤 job 상태를 되돌리고 재시작 |
| Drop 시각인데 READY 아님 | Drop CLOSING/FINALIZING | `drop.delayed` 1회, 준비되면 RELEASED. 미리 공개하지 않는다 |
| WS 끊김 | 클라이언트 이벤트 누락 | 재접속 시 `world.snapshot` + manifest 재요청. replay 없음 |

## 결정성

같은 job(범위) 은 같은 seed 로 다시 돈다. 하지만 worker 의 물리 상태(표면)는 재시도 시 `input_snapshot` 으로 되돌리므로 첫 시도와 물리적으로 같은 출발점이다. 결과 transform 은 Rapier 가 결정적이라 같은 입력이면 같다(같은 wasm 바이너리 기준).

## 테스트 (`apps/world-server/tests`)

| 테스트 | 내용 |
| --- | --- |
| `worker.test.ts` | 자식 프로세스 시뮬레이션; DEV_CRASH 로 죽여도 main 살아 있고 대기 요청은 `WorkerCrashError`, 새 worker 가 표면에서 이어감 |
| `pipeline.test.ts` | 40개 동시 구매 → 연속 시뮬레이션 → chunk checksum 일치·범위 연속; 파이프라인 도중 worker crash 시 유실·중복 0; chunk 쓰기 실패 시 이전 version 유지(원자성); cutoff 라우팅과 READY/RELEASED/DELAYED 전이 |
| `recovery.test.ts` | 서버 재시작: 파일 손상/누락을 DB 에서 복원, 미커밋 팬케이크 이어서 처리, serial 연속; 재시도 상한 초과 → job FAILED, Drop FAILED, 파이프라인 정지 |
| `concurrency.test.ts` | 600 구매 vs 연속 커밋 교착 없음(락 순서 회귀); 커밋 도중 지연된 refresh 가 상태를 덮어쓰지 않음 |
| `http.test.ts` | idempotent 구매, manifest/chunk etag·immutable·304, pancake 조회; WS snapshot·resync |
| `serial.test.ts`, `scheduler.test.ts` | 원자 할당(동시 100건 중복 0), 국가 카운터, 결정적 Drop id / cutoff |

## 운영자 개입이 필요한 경우

- Drop FAILED: `simulation_jobs` 의 FAILED 행을 보고 원인(worker 로그) 해결 → 행을 `RETRYABLE`, `attempt=0` 으로 되돌리고 Drop 을 다시 열거나 다음 Drop 으로 옮긴 뒤 서버 재시작.
- 이 절차의 자동화(관리 API)는 Phase 3 에서.
