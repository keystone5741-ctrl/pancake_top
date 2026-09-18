# Phase 3A — Infrastructure Benchmarks

2026-09-18. 환경: 컨테이너 4 vCPU / 16 GB, Node 22.22, PostgreSQL 16(같은 머신), Rapier 0.20.0 wasm, S3 호환 저장소는 로컬 mock(s3rver, 같은 머신) — 네트워크 지연이 없는 수치라 실제 S3/R2 에서는 업로드·HEAD 가 수십 ms 단위로 커진다. headless Chromium(SwiftShader). 상대 비교와 구조 검증용. 원본 JSON: `phase3a-*.json`.

## 1. 파이프라인 처리량 (§4-B, §6) — `bench/drop100k.ts`

100,000 장 연속 Drop (18k 주문, batch 100, 실제 worker + PostgreSQL + 로컬 파일 저장소).

| 구성 | 결과 |
| --- | --- |
| Phase 2 (순차, worker 전체 탑 O(n) 작업 포함) | 138.7 s, 721 장/s, job p50 122 ms (worker 98 ms) |
| Phase 3A 순차 (`PIPELINE_OVERLAP=0`) — worker O(n) 제거만 | 83.0 s, **1204 장/s**, job p50 61 ms (worker 27 ms), p95 88 ms |
| **Phase 3A 파이프라인 (`PIPELINE_OVERLAP=1`)** | 67.5 s, **1482 장/s**, job p50 66 ms (worker 27 ms), p95 113 ms |

- 목표 ≥ 1,000 장/s 달성: **1482 장/s** (Phase 2 대비 ×2.05). 겹친 커밋 1000, 버린 결과 0, 재시도 0, 크래시 0.
- 어디서 왔나: worker 안의 job 당 전체 탑 정렬/계측 제거가 98 → 27 ms (물리 자체는 그대로), 파이프라인 겹침이 커밋 26 ms(DB tx 22 ms, 인코딩 1.6 ms, 업로드 1.7 ms)를 물리 뒤에 숨긴다.
- **Natural 회귀 없음**: 침투 p95 최대 0.145 / max 0.180 (기준 p95 < 0.2, max < 0.5), 기울기 median 2.13°, 누출 0, 높이 1010.2 m — Phase 2 의 1,010.2 m 와 같다. 순차/파이프라인의 모양 지표가 동일(같은 seed·같은 입력 → 같은 결과).
- 정합성: 할당 = 커밋 = 100,000, job 1,000 모두 DONE.

## 2. Batch 재검증 (§7) — `bench/batch-policy.ts`

5,000 장, batch 10 → 1000, 순차 vs 파이프라인.

| batch | 순차 장/s | 파이프라인 장/s | 이득 | job p50 (worker) | job p95 순차 → 파이프라인 | 침투 p95 / max (파이프라인) | 기울기 | 높이 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 10 | 460 | **763** | ×1.66 | 12 ms (3) | 20 → 34 ms | 0.106 / 0.106 | 2.07° | 50.43 m |
| 25 | 793 | **1226** | ×1.55 | 16 ms (8) | 36 → 39 ms | 0.101 / 0.101 | 2.21° | 50.45 m |
| 50 | 1036 | **1539** | ×1.49 | 24 ms (14) | 51 → 46 ms | 0.090 / 0.133 | 2.11° | 50.46 m |
| 100 | 1259 | **1692** | ×1.34 | 43 ms (31) | 87 → 69 ms | 0.101 / 0.121 | 2.19° | 50.58 m |
| 250 | 1432 | **1761** | ×1.23 | 107 ms (92) | 219 → 288 ms | 0.100 / 0.194 | 2.25° | 50.72 m |
| 500 | 1318 | **1525** | ×1.16 | 257 ms (232) | 366 → 409 ms | 0.115 / 0.141 | 2.29° | 50.66 m |
| 1000 | 1569 | **1513** | ×0.96 | 517 ms (458) | 546 → 780 ms | 0.115 / 0.146 | 2.30° | 50.69 m |

- 파이프라인 이득은 작은 batch 에서 크다(10: ×1.66, 100: ×1.34). 250 이상은 물리 시간이 커밋 시간을 훨씬 넘어 이득이 줄고, p95 지연만 커진다.
- 모양 지표는 batch·파이프라인과 무관(침투 p95 0.09~0.12, 기울기 2.1~2.3°, 높이 50.4~50.7 m — 구매 수량이 랜덤이라 ±0.2 m).
- **기본값 100 유지**: 구매→커밋 지연 ≈ 250 ms(window) + 43 ms, 처리량은 1.7k 장/s 로 포화 근처. 250 은 +4 % 처리량에 p95 가 4 배.

## 3. 객체 저장소 (§8~§12, §29) — `bench/storage-1m.ts`

1M 합성 월드를 S3 호환 저장소(로컬 mock)에 심고 WorldStore 로 cold start.

| 항목 | 값 |
| --- | --- |
| seed (chunk 인코딩 + 업로드 100개 + pancakes 1M 행 + 국가 serial) | 28 s |
| chunk bytes / 업로드 p50 · p95 | 38.2 MB / 4.6 · 10.2 ms (380 KB 객체, localhost) |
| DB | 495 MB (chunks 40 MB, pancakes 447 MB, simulation_jobs 24 kB, world_events 32 kB) |
| cold start (`load` = world_state + reconcile: HEAD 100 + list) | 470 ms |
| manifest 생성 / 크기 | 2 ms / 56 KB (571 B/chunk) |
| chunk GET 저장소 cold p50 · p95 / warm p50 / DB BYTEA p50 | 3.2 · 9.9 ms / 2.7 ms / 2.9 ms |
| Find #1 / #54321 / #500000 / #999999 / #1000000 (행 조회 + chunk GET + decode) | 5 / 3 / 3 / 4 / 3 ms |
| 메모리 (seed 프로세스 rss) | 144 MB |

- 저장소 요청 307회, 재시도 0, 업로드 38.2 MB.
- 실제 S3/R2 에서는 왕복 20~80 ms 가 더해진다: cold start 는 HEAD 를 순차로 하므로 100 chunk 에 2~8 s, 1,000 chunk 에 20~80 s 가 될 수 있다 → 병렬 HEAD(동시 16) 는 다음 개선 후보. Find 는 chunk 1개 GET 이므로 +1 RTT.


## 4. 압축 (§13) — `bench/compression.ts`, `world-prototype/bench/compression.ts`

| 데이터 | raw | gzip-6 | gzip-9 | brotli-4 | brotli-9 |
| --- | --- | --- | --- | --- | --- |
| 100,000 (10 chunk) | 3.8 MB | 84.2% (압축 10.9 ms/chunk, 해제 2.4 ms/chunk) | 84.2% (압축 11.8 ms/chunk, 해제 2.3 ms/chunk) | 84.0% (압축 3.2 ms/chunk, 해제 3.2 ms/chunk) | 82.6% (압축 36.9 ms/chunk, 해제 3.2 ms/chunk) |
| 500,000 (50 chunk) | 19.1 MB | 83.9% (압축 10.5 ms/chunk, 해제 2.1 ms/chunk) | 83.9% (압축 10.4 ms/chunk, 해제 2.1 ms/chunk) | 83.8% (압축 2.7 ms/chunk, 해제 3.3 ms/chunk) | 80.6% (압축 41.5 ms/chunk, 해제 3.1 ms/chunk) |
| 1,000,000 (100 chunk) | 38.2 MB | 83.9% (압축 10.1 ms/chunk, 해제 2.0 ms/chunk) | 83.9% (압축 10.2 ms/chunk, 해제 2.0 ms/chunk) | 83.7% (압축 2.5 ms/chunk, 해제 3.3 ms/chunk) | 80.0% (압축 44.0 ms/chunk, 해제 3.2 ms/chunk) |

브라우저(Chromium, Content-Encoding 으로 서빙): raw 4.72 ms/chunk · gzip 6.03 ms/chunk · brotli 8.19 ms/chunk (fetch+arrayBuffer, localhost, 100k = 10 chunk; 응답 평균 2.1 / 3.8 / 6.0 ms).

**결정: raw 유지.** transform 은 float32 라 16~20 % 밖에 줄지 않고, 그 대가로 서버 CPU(gzip-6 1M 당 1.0 s, brotli-9 4.4 s)와 브라우저 해제 시간(+1.3~3.5 ms/chunk)이 든다. chunk 하나(380 KB)를 320 KB 로 만드는 이득은 Slow 3G 에서도 ≈1.2 s 인데, Find 는 chunk 1~2 개만 받는다. CDN 에서 gzip 을 켜는 것은 무해하지만 기본은 raw. 위치를 양자화(int16)하면 40 % 대로 줄겠지만 그것은 포맷 변경(PKCH v2)이며 Phase 3A 범위 밖.

## 5. Leader failover (§22~§23)

`bench/dual-server.sh` 2단계: 생존 인스턴스 B 에 50 req/s 를 걸어 둔 채 leader A 를 `kill -9`.

| 항목 | 값 |
| --- | --- |
| A 가 죽은 뒤 B 가 leader 가 되기까지 | **307 ms** (`LEADER_LEASE_MS=1000`, 즉 poll 주기 안) |
| leader_lease | B, term 2 (A term 1 → B term 2); `leader.changed` 이벤트 순서 A:true → B:true |
| 같은 Drop 이어감 | B 가 `drop_20260918T063400Z`(SIMULATING) 의 남은 팬케이크를 이어서 커밋, 부하 중 오류 0, 이후 drain 1 s |
| job 이중 실행 | 0 (DONE job 범위 중복 0). A 가 들고 있던 in-flight job 은 lease(`JOB_LEASE_MS=5000`) 만료 뒤 B 가 회수 |
| serial | 중복 0 / 빈틈 0 / 유실 0 (2단계 5,429 장) |

in-process 버전(`tests/cluster.test.ts`, 락 커넥션 강제 종료)에서도 follower 가 300 ms poll 안에 leader 가 되고 160 장이 연속으로 커밋된다.


## 6. 2-서버 부하 (§21, §24, §32) — `bench/dual-server.sh`

| 구간 | 대상 | req/s | 성공/오류 | p50 | p95 | max | 할당 serial | 중복 | 빈틈 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 (A+B 라운드로빈) | A,B | 10 | 100/0 | 5.7 ms | 9.0 ms | 21.0 ms | 529 | 0 | 0 |
| 1 (A+B 라운드로빈) | A,B | 50 | 500/0 | 4.1 ms | 7.3 ms | 39.5 ms | 2,791 | 0 | 0 |
| 1 (A+B 라운드로빈) | A,B | 100 | 1000/0 | 3.5 ms | 10.8 ms | 70.9 ms | 5,388 | 0 | 0 |
| 1 burst (cutoff ±2 s) | A,B | ≈184 | 735/0 | | 10.5 ms | | 4,030 → {"drop_20260918T063200Z": 357, "drop_20260918T063400Z": 378} | 0 | 0 |
| 2 (leader kill 중, 생존 B 만) | B | 50 | 1000/0 | 3.7 ms | 5.6 ms | 19.7 ms | 5,426 | 0 | 0 |

- 두 인스턴스(A 8787, B 8788)가 같은 PostgreSQL 과 저장소를 쓴다. 시작 시 A 가 leader, B 는 follower 로 구매·조회·WS 만. 두 서버 모두 200 응답, 국가 KR/JP/US/BR/ID/ZZ 랜덤.
- 최종 SQL 정합성: pancakes 1,044,081 행 = distinct serial = max serial = world_state.latest_global_serial; **국가 serial 중복 0; 미커밋 0; 같은 범위 DONE job 중복 0**; 모든 job DONE (568개).
- 파이프라인은 부하 동안 계속 돌았고 burst 뒤 남은 분량은 1 s 안에 커밋됐다(drain 1 s). 1M 합성 월드 위이므로 worker 표면은 1M 탑 꼭대기 512 장.


## 7. 10M synthetic metadata (§30~§31)

10M 팬케이크(1,000 chunk)를 합성 transform 으로 만들어(물리 없음) DB 행·chunk·객체 저장소·manifest·Find·streaming 구조를 검증했다.

| 항목 | 값 |
| --- | --- |
| seed (chunk 1,000개 인코딩+업로드, pancakes 10M 행 INSERT) | 82 s |
| chunk bytes | 382 MB (업로드 p50 3.8 ms / p95 9.1 ms) |
| DB | 2462 MB (chunks 397 MB, pancakes 2057 MB, simulation_jobs 24 kB, world_events 32 kB) |
| cold start (reconcile: HEAD 1,000 + list) | 3682 ms |
| manifest 생성 / 크기 | 21 ms / **559 KB** (573 B/chunk) |
| chunk GET cold p50 · p95 / warm / DB | 1.9 · 6.2 ms / 1.9 ms / 2.8 ms |
| Find #1 / #54321 / #5,000,000 / #9,999,999 / #10,000,000 | 4 / 3 / 3 / 3 / 3 ms |
| 높이 (합성) | 100.0 km |
| seed 프로세스 rss | 344 MB (chunk 단위 생성이라 상수) |

- **Manifest scalability (§31)**: 1,000 chunk 에 559 KB (573 B/chunk, bounds·sha256·url 포함). gzip 이면 ≈ 1/4. 10M 에서도 한 번의 GET 으로 충분하고 클라이언트는 `updateManifest` 로 증분 갱신하므로 **paged/segmented manifest 는 아직 필요 없다.** 100M(10,000 chunk ≈ 5.6 MB) 부터 summary + 세그먼트 구조를 검토한다.
- pancakes 테이블이 DB 크기의 대부분이다(행당 ≈ 250 B, 인덱스 포함). 10M 은 문제없고, 100M 이면 파티셔닝(drop_id 또는 chunk_id 범위) 검토.
- Find 는 규모와 무관하게 pancakes PK 조회 + chunk 1개 GET(380 KB) + decode 로 수 ms(로컬). 클라이언트도 chunk 1~2개만 받는다(Phase 2 스트리밍 벤치와 같은 경로).
- 첫 시도에서 국가 serial 을 10M 행 UPDATE 로 매기는 벤치 스크립트가 14 분 넘게 걸려 중단했고, 결정적 분포로 INSERT 시점에 계산하도록 바꿨다(제품 코드는 트랜잭션 안에서 카운터로 할당하므로 무관).


## 8. Speculative parallel simulation 연구 (§4-C) — `bench/speculative.ts`

"다른 worker 가 한 batch 늦은 표면 위에서 다음 batch 를 미리 계산" 했을 때 authoritative 결과와의 차이 (3,000 장, batch 100, 불일치 = 위치 차 > 0.05 units 인 팬케이크가 하나라도 있음).

| seed | 비교 batch | 불일치 (재계산율) | 최대 위치 차 | 순차 시간 → 투기 추가 작업 |
| --- | --- | --- | --- | --- |
| 1 | 29 | 28 (97 %) | 0.92 units (9.2 cm) | 1.1 s → +1.8 s |
| 2 | 29 | 28 (97 %) | 0.87 units (8.7 cm) | 0.8 s → +1.6 s |
| 3 | 29 | 28 (97 %) | 1.02 units (10.2 cm) | 0.8 s → +1.7 s |

**결론: 기각.** 표면이 한 batch 만 어긋나도 97 % 의 batch 가 재계산 대상이고(최대 차이 ≈ 1 unit = 팬케이크 지름), 투기 작업은 순차 시간의 2 배를 더 쓴다. 팬케이크는 바로 아래 batch 위에 놓이므로 예측 표면이 맞을 수 없다. 물리 lane 은 하나로 유지하고(§3), 처리량은 파이프라인·worker 최적화로 얻는다(§1).

## 9. Rapier 버전 실험 (§34) — `tests/rapier`

| 빌드 | 결과 |
| --- | --- |
| `@dimforge/rapier3d-compat@0.20.0` (제품) | 시드 1·2·3 모두 2~3 배치 안에 `unreachable` 패닉 |
| `@dimforge/rapier3d-compat@0.0.0-5de07a4-20260808` (0.20.0 직전 canary, 최신 pre-release) | 같은 시드에서 같은 지점에 패닉 (`version()` 도 0.20.0) |
| `@dimforge/rapier3d@0.20.0` (non-compat) | Node 에서 번들러 없이 wasm 모듈을 직접 로드할 수 없어 미실행 (브라우저 번들 전용) |
| 제거하지 않는 대조군 (canary) | 완주 |

npm 에 0.20.0 보다 새 release 는 없다(2026-09-18). **판정: 패닉 여전 → `freezeMode:"rebuild"` 우회 유지, upgrade 제안 없음.** 새 release 가 나오면 `pnpm --filter rapier-repro repro -- --package <alias>` 로 먼저 확인하고, 사라졌을 때만 Natural 100k 회귀표(`apps/physics-prototype/bench/phase1.ts`)를 새 버전으로 돌린다.

## 10. 테스트 (§36)

`apps/world-server/tests` 32개 통과: storage(어댑터 3종 CRUD/list 1,100 객체/4xx, 업로드 실패·검증 불일치·재시작 reconcile), admin(3회 실패 → FAILED + 시도 기록, 인증, retry 완료, abort 이동), events(순서·replay·retention·snapshot fallback·인스턴스 간 배달), cluster(leader 하나, follower 구매, leader crash → failover → 같은 Drop 이어감, 이중 job 0, 2-인스턴스 동시 1,000 주문 serial/국가 serial/idempotency), 기존 pipeline/recovery/concurrency/worker/http/serial/scheduler. `tests/rapier` 3개.
