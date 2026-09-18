# Phase 2 — Server Benchmarks

2026-09-18. 환경: 컨테이너 4 vCPU / 16 GB, Node 22.22, PostgreSQL 16 (같은 머신, 로컬 소켓 대신 127.0.0.1), Rapier 0.20.0 wasm, headless Chromium + SwiftShader(렌더 FPS 는 의미 없음, 구조·네트워크 수치만). 실제 서비스 수치가 아니라 **구조 검증과 상대 비교**용이다. 원본: `phase2-*.json`, `phase2/phase2-streaming.json`.

## 1. 구매 부하 (§43) — `apps/world-server/bench/load.ts`

서버: `DROP_INTERVAL_SECONDS=120 DROP_CUTOFF_SECONDS=20`, 1M 합성 월드 위. 클라이언트는 open-loop(응답을 기다리지 않고 일정 간격 발사), 수량 1~10 랜덤, 국가 8종 랜덤.

| 목표 req/s | 보낸 수 | 성공 / 오류 | 지연 p50 | p95 | max | 실제 rps | 할당 serial | 중복 | 빈틈 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 10 | 10 / 0 | 12.4 ms | 24.1 ms | 24.3 ms | 1.1 | 58 | 0 | 0 |
| 10 | 100 | 100 / 0 | 5.6 ms | 10.7 ms | 20.9 ms | 10.1 | 566 | 0 | 0 |
| 50 | 500 | 500 / 0 | 3.9 ms | 5.6 ms | 12.5 ms | 50.1 | 2,777 | 0 | 0 |
| 100 | 1000 | 1000 / 0 | 3.3 ms | 6.7 ms | 24.8 ms | 100.1 | 5,454 | 0 | 0 |
| **합계** | | | | | | | 8,858 (서버 +8,858) | 0 | 0 (유실 0) |

- **serial 검증**: 이 클라이언트가 받은 범위끼리 중복 0, 빈틈 0, 합계 = 서버 `latest_global_serial` 증가분 (유실 0). idempotencyKey 재전송은 같은 주문(200, `replayed: true`).
- **cutoff burst** (§44): cutoff −2 s ~ +2 s 동안 5 ms 간격으로 몰아 보냄. 733건 (≈183 req/s) 모두 성공, `drop_20260918T042200Z` 에 359건 / 다음 Drop `drop_20260918T042400Z` 에 374건. cutoff 뒤에 닫힌 Drop 으로 들어간 주문 0, 중복 0, 빈틈 0. 닫힌 Drop 은 READY (12,306 장).
- 부하 동안 파이프라인은 계속 돌았다(연속 시뮬레이션). burst 뒤 남은 대기분은 1 s 안에 커밋됐다 (job p50 44 ms / p95 59 ms, 커밋 평균 10.5 ms, worker 크래시 0, 재시도 0). 최종 할당 1,025,911 = 커밋 1,025,911.

## 2. 100k 연속 Drop (§44) — `bench/drop100k.ts`

한 Drop 에 100,000 장(18,001 주문, 1~10 장) → cutoff → 연속 시뮬레이션 → READY → RELEASED. 실제 worker 프로세스 + PostgreSQL + 로컬 파일. batch 100.

| 항목 | 값 |
| --- | --- |
| 구매 100k 장 | 36.9 s (487 주문/s, 50 동시) — 이 동안 27,900 장이 이미 커밋됨 |
| 전체 (첫 구매 → 마지막 커밋) | 138.7 s = **721 장/s** |
| cutoff 후 남은 시뮬레이션 | 101.7 s |
| job | 1,000개 모두 DONE, 벽시계 p50 122 ms / p95 193 ms (worker 물리 p50 98 ms, IPC+커밋 오버헤드 평균 28 ms) |
| 커밋 | 평균 23.0 ms × 1,000 (chunk 인코딩+파일 2.1 ms 포함), world version 1,000 |
| chunk | 10개 finalized, 4.0 MB; snapshot 11개 (10k 마다 + READY) |
| 모양 | 침투 p95 최대 0.096, max 0.180, 기울기 median 2.17°, 누출 0 — Phase 0.5/1 회귀표와 같은 범위 |
| 높이 | 1,010.2 m (100k × 1 cm 이상적 1,000 m 대비 101 %) |
| 정합성 | pancakes.committed_at 100,000 = 할당 100,000 = drops.pancake_count; 중복·유실 0 |
| worker | 크래시 0, 재시작 1(초기 spawn), 재시도 0 |
| 메모리 / DB | main rss 157 MB (worker 별도), DB 168 MB (job 별 input_snapshot 20 MB 포함) |
| 이벤트 | queueUpdated 74 (throttle), world.updated 1,000, closing/ready/released 각 1 |

Phase 1 브라우저 내 연속 시뮬레이션(100k, 단일 프로세스)은 ≈1,150 장/s 였다. 서버는 job 마다 IPC(PKT1 왕복) + DB 트랜잭션 + chunk 재인코딩이 붙어 721 장/s (batch 정책 벤치의 1.4k 장/s 는 구매와 겹치지 않은 순수 처리량). 연속 시뮬레이션이므로 Drop 10분 동안 계속 처리하고, cutoff 시점에는 마지막 몇 초 분량만 남는다. 이 처리량이면 **Drop 당 ≈ 40만 장**(10분 × 721 장/s)까지 cutoff 60 s 안에 READY 가 된다. 그 이상은 worker 다중화(Phase 3)가 필요하다.

## 3. Batch 정책 (§27) — `bench/batch-policy.ts`

5,000 장(1~10 장 주문, 20 동시)을 batch 10 → 1000 으로 처리. 각 batch 마다 새 DB·새 worker.

| batch | 벽시계 | 장/s | job 수 | job p50 (worker) | 오버헤드/job (비율) | 커밋 avg | 침투 p95 / max | 기울기 | 높이 | rss |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 10 | 9.8 s | 511 | 500 | 13 ms (6) | 8.9 ms (58 %) | 7.3 ms | 0.083 / 0.106 | 2.18° | 50.43 m | 143 MB |
| 50 | 4.2 s | 1,177 | 100 | 28 ms (17) | 17.2 ms (47 %) | 12.1 ms | 0.092 / 0.133 | 2.13° | 50.46 m | 137 MB |
| **100** | 3.5 s | 1,439 | 51 | 45 ms (34) | 22.1 ms (36 %) | 13.7 ms | 0.089 / 0.106 | 2.24° | 50.48 m | 149 MB |
| 250 | 3.2 s | 1,547 | 21 | 111 ms (95) | 37.8 ms (26 %) | 18.1 ms | 0.104 / 0.217 | 2.33° | 50.64 m | 148 MB |
| 500 | 3.4 s | 1,477 | 11 | 251 ms (229) | 58.6 ms (20 %) | 18.8 ms | 0.115 / 0.141 | 2.26° | 50.66 m | 149 MB |
| 1000 | 3.3 s | 1,500 | 6 | 507 ms (450) | 97.2 ms (18 %) | 26.7 ms | 0.113 / 0.165 | 2.31° | 50.60 m | 150 MB |

- 처리량은 batch 100 부터 포화(≈1.4~1.5k 장/s). 10 은 오버헤드가 절반을 넘는다.
- 모양(침투·기울기·높이)은 batch 와 무관(±0.02 m). 물리 sub-batch 는 항상 ≤500 (Phase 0.5 검증 범위).
- **기본값 100**: 구매가 커밋되기까지 ≈ 250 ms(batch window) + 45 ms. 큰 batch 는 지연만 늘고 처리량 이득이 없다.
- 이 벤치가 두 가지 동시성 버그를 드러냈다(아래 §6).

## 4. 1M 영속 월드 스트리밍 (§45, §46) — `apps/world-prototype/bench/streaming.ts`

`bench/seed-synthetic.ts` 로 1M 합성 팬케이크(물리 없음, 100 chunk, 38.2 MB, DB 270 MB, 10.2 s)를 심고 서버를 띄운 뒤 world-prototype `?source=server` 를 headless Chromium 으로 연다. 시나리오마다 새 브라우저 context(HTTP 캐시 없음).

| 시나리오 | 받은 chunk | 바이트 | 렌더 인스턴스 | 선택 | 비고 |
| --- | --- | --- | --- | --- | --- |
| Top (탑 꼭대기 근접) | 2 / 100 | 0.76 MB | 10,000 | — |  |
| Find #1 | 1 / 100 | 0.38 MB | 10,000 | #1 → chunk 0 |  |
| Find #54321 | 2 / 100 | 0.76 MB | 10,000 | #54321 → chunk 5 |  |
| Find #999999 | 2 / 100 | 0.76 MB | 10,000 | #999999 → chunk 99 |  |
| Full Tower | 1 / 100 | 0.38 MB | 0 | — | 실루엣만 (모든 chunk 서브픽셀) |
| Top 에서 Find #54321 호출 | +1 | — | — | #54321 → chunk 5 | 151 ms, chunk 5 만 추가로 받음 |

- **정책 변경 전**(Phase 1 정책: 절두체 안 chunk 는 전부 GPU_LOW): Top 뷰 94/100 chunk 35.9 MB, Find #999999 86 chunk 32.8 MB, Full 100/100. 서브픽셀 chunk 까지 전부 받았다.
- **변경 1 — `minVisiblePx` 0.5**: 가장 가까운 팬케이크가 0.5 px 미만으로 투영되는 chunk 는 받지 않고 실루엣(Far View B)이 그린다. Top 56, Find #999999 56 으로 줄었지만 비행 경로가 탑을 따라 내려가며 지나치는 chunk 는 여전히 받았다.
- **변경 2 — 예측 fetch**: 비행 중에는 도착 지점 카메라로 fetch 를 결정한다. 위 표가 그 결과다. Find 는 대상 chunk 와 그 이웃만 받는다.
- Full Tower 는 모든 chunk 가 서브픽셀이라 아무것도 받지 않고 실루엣만 그린다(1M 인스턴스 ≈ 217 MB GPU 메모리를 쓰지 않는다). 가까이 가면 그때 받는다.
- "Loading pancake #…" 상태: 로컬 속도에서는 151 ms 만에 끝나 관찰되지 않지만, throttling 3종 모두에서 `Loading pancake #500,000…` 이 떠 있다가 chunk 도착 후 `#500,000 → chunk 49 / instance …` 로 바뀐다 (`phase2-streaming-throttle.json` statusTexts).
- 네트워크 throttling (CDP): Fast 4G (4 Mbps, 20 ms): 페이지 준비 3.3 s, Find #500000 1.1 s (2 chunk 0.76 MB); 3G (1.6 Mbps, 150 ms): 페이지 준비 7.3 s, Find #500000 4.7 s (2 chunk 0.76 MB); Slow 3G (400 kbps, 400 ms): 페이지 준비 27.1 s, Find #500000 23.4 s (3 chunk 1.10 MB). Find 는 대상 chunk(380 KB) 하나만 기다리면 되므로 Slow 3G 에서도 ≈ 23 s 이고, 이는 순수 전송 시간(380 KB / 400 kbps ≈ 8 s + 이웃 chunk) 수준이다. 페이지 준비 시간(앱 번들 ≈ 1 MB)이 더 크다.

## 5. Rapier 패닉 재현 (§53)

`docs/phase2/RAPIER_020_PANIC.md`. 순수 Rapier 스크립트로 시드 3개 모두 2~3 배치(40~60장) 안에 `unreachable`. 제거하지 않거나 처음부터 dynamic 인 채 제거하면 안 난다. 제품 `freezeMode:"rebuild"` 는 3,000장 완주.

## 6. 벤치가 찾은 버그 (수정·회귀 테스트 포함)

| 버그 | 증상 | 수정 |
| --- | --- | --- |
| 구매 ↔ 커밋 교착 | batch 벤치(20 동시 구매 + 연속 커밋)에서 PostgreSQL `deadlock detected`. purchase 는 `world_state → drops`, commit 은 `drops → world_state` 순으로 잠갔다 | commit 트랜잭션이 `world_state FOR UPDATE` 를 먼저 잡는다. `tests/concurrency.test.ts` (600 구매 vs 커밋) |
| stale refresh | pool 포화 시 `store.refresh()` 의 world_state 읽기가 커밋 뒤에 도착해 메모리 상태를 되돌림 → 다음 job `commit out of order` 로 재시도 | commit / refresh / snapshot 을 store mutex 로 직렬화. 읽기를 커밋 뒤로 지연시키는 결정적 테스트 |

두 경우 모두 데이터는 깨지지 않았다(트랜잭션 롤백 + job 재시도). 다만 재시도는 처리량을 깎고, 무한 재시도 금지 규칙 때문에 3회 연속이면 Drop 이 FAILED 가 될 수 있었다.

## 7. Crash 복구 (§23~§25, §37) — 테스트로 검증

`apps/world-server/tests` 18개 통과 (pipeline / recovery / worker / http / concurrency / serial / scheduler). 시나리오: worker DEV_CRASH 도중 job → RETRYABLE → 새 worker 가 input_snapshot 으로 이어감(유실·중복 0); chunk 쓰기 실패 → 이전 version 유지; 서버 재시작 → 파일을 DB 로 복원, 미커밋 팬케이크 이어서 처리; 재시도 3회 초과 → job/Drop FAILED, 파이프라인 정지.

## 8. 서버 지표 (§42)

`GET /api/dev/metrics`: purchaseEventsPerSec, pendingSimulationPancakes, simulationThroughputPerSec, simulationJobP50/P95Ms, workerCrashes/Restarts, jobRetries/Failed, dropFinalizeMsP50/Max, chunkWriteMsAvg, commitMsAvg, manifestMs, snapshots, recoveredFiles, websocketClients, worldVersion, pipelineRunning/Stopped, lastJob(물리 지표). 부하 테스트 로그에 함께 찍힌다.
