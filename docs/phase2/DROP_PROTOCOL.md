# Phase 2 — Drop Protocol (HTTP + WebSocket)

Phase 2 §5~§10, §28~§33, §38, §39.

## Drop 생명주기

```text
              구매 가능                 cutoff (scheduledAt − DROP_CUTOFF_SECONDS)     scheduledAt
  ┌──────────┴──────────┐                       │                                     │
  OPEN ──▶ SIMULATING ──▶ CLOSING ──▶ FINALIZING ──▶ READY ──▶ RELEASED
   (첫 job 시작)      (마지막 구매까지 시뮬)  (남은 job 없음)   (시각 도래)
  어디서든 ──▶ FAILED (job 재시도 상한 초과; 파이프라인 정지, 운영자 개입)
```

- **id**: `drop_20260918T031000Z` = scheduledAt(UTC). 서버가 재시작해도 같은 시각이면 같은 id. `DropScheduler.currentDrop(now)`: cutoff 전이면 다음 10분 경계, 지났으면 그 다음.
- **구매 라우팅**: `acceptsPurchases` 인 상태(OPEN, SIMULATING)만 받는다. cutoff 를 지난 요청은 자동으로 다음 Drop 에 들어간다(거부하지 않는다).
- **연속 시뮬레이션**이므로 CLOSING 에서 남은 것은 마지막 몇 job 뿐이다. `FINALIZING` 은 "닫힌 뒤에도 커밋되지 않은 팬케이크가 남아 있다"는 표시.
- **READY** 로 갈 때 반드시 `world_snapshots` 행을 남긴다(§35). 시각이 됐는데 READY 가 아니면 `drop.delayed` 를 한 번 보내고 준비되는 대로 RELEASED 로 간다(§30: 늦게 공개, 미리 공개 금지).
- **RELEASED** 는 서버 상태이고, 클라이언트는 `drop.released` 를 받고 나서야 그 범위를 보여준다(재생은 클라이언트 DropReplay).

## HTTP (§38, §39)

| 메서드 | 경로 | 응답 |
| --- | --- | --- |
| GET | `/api/world` | `world.snapshot` 과 같은 JSON (version, totalPancakes, committedPancakes, heightMeters, currentDrop, nextDropAt, serverTime) |
| GET | `/api/world/manifest` | `{ version, totalPancakes, allocatedPancakes, heightMeters, heightUnits, chunkSize, diameter, thickness, unitCm, chunks: [{ id, startSerial, endSerial, count, minHeight, maxHeight, bounds, checksum(sha256), byteLength, finalized, url }] }`; `etag: "v<version>"` |
| GET | `/api/world/chunks/:id?c=<checksum16>` | `.chunk` 바이너리(PKCH v1). `etag`, `x-chunk-sha256`; finalized 이고 `c` 가 맞으면 `cache-control: public, max-age=31536000, immutable`, 아니면 `no-cache`. `If-None-Match` → 304 |
| GET | `/api/drops/current` | 현재 구매가 들어가는 Drop 행 |
| GET | `/api/drops/:id` | Drop 행 (status, start/end serial, pancake_count, height_before/after, 시각들) |
| GET | `/api/pancakes/:serial` | `{ globalSerial, country, countrySerial, dropId, chunkId, instanceIndex, variant, committed, height }` — chunk 헤더/transform 에서 높이를 읽는다 |
| POST | `/api/dev/purchase` | body `{ quantity: 1..10000, country?: "KR", idempotencyKey? }` (헤더 `Idempotency-Key` 도 됨). 201 = 새 주문, 200 = replay. 응답 `{ orderId, dropId, startSerial, endSerial, countryStartSerial, countryEndSerial, replayed, scheduledAt }` |
| GET | `/api/dev/status` | world_state, currentDrop, nextDrop, pending, worker 상태, job 상태별 수, metrics |
| GET | `/api/dev/metrics` | §42 지표: purchaseEventsPerSec, pendingSimulationPancakes, simulationThroughputPerSec, simulationJobP50/P95Ms, workerCrashes/Restarts, jobRetries/Failed, dropFinalizeMs, chunkWriteMsAvg, commitMsAvg, manifestMs, snapshots, websocketClients, worldVersion, pipelineRunning/Stopped, lastJob |
| POST | `/api/dev/tick` | `{ now? }` 로 tick 강제 (테스트) |
| POST | `/api/dev/worker/crash` | worker `process.exit(137)` (복구 시연) |
| GET | `/dev` | 디버그 HTML (현재 Drop, 큐, worker, 최근 이벤트, 구매 버튼) |

CORS: `access-control-allow-origin: *`. `/api/dev/*` 는 `DEV_ENDPOINTS=0` 이면 없다.

## Serial 할당 (§8~§10)

한 트랜잭션: `world_state` 행 `FOR UPDATE` → `latest_global_serial += quantity` → `country_counters` upsert → `orders` 행 → `pancakes` 행 quantity 개(`generate_series`; `chunk_id = (serial−1) div CHUNK_SIZE`, `instance_index = (serial−1) mod CHUNK_SIZE`) → `drops.start/end_serial, pancake_count` 갱신. 같은 `idempotencyKey` 는 기존 주문을 그대로 돌려준다(`replayed: true`). UI serial 은 1부터(#1), 엔진 id 는 0부터.

동시성 검증: 부하 테스트에서 중복 0 / 유실 0 (`docs/benchmarks/phase2-server.md`). 커밋 트랜잭션도 `world_state` 를 먼저 잠근다 — 잠금 순서가 다르면 교착한다(회귀 테스트 `tests/concurrency.test.ts`).

## WebSocket `/ws` (§31~§33)

접속 즉시 `world.snapshot` 을 보낸다. 이후 이벤트 broadcast. 클라이언트 → 서버: `{"type":"resync"}` (snapshot 재전송), `{"type":"ping"}` → `{"type":"pong", serverTime}`. 누락 이벤트 replay 는 없다: 재접속하면 snapshot 으로 복구하고 manifest 를 다시 받는다(§33).

| type | 필드 | 언제 |
| --- | --- | --- |
| `world.snapshot` | version, totalPancakes(할당), committedPancakes, heightMeters, currentDrop{dropId,status,scheduledAt,cutoffAt,pancakeCount,queueSize}, nextDropAt, serverTime | 접속, resync |
| `drop.queueUpdated` | dropId, queueSize, scheduledAt | 구매 후, `QUEUE_THROTTLE_MS`(500) throttle |
| `drop.closing` | dropId, scheduledAt, nextDropId | cutoff 도달 |
| `drop.ready` | dropId, scheduledAt, pancakeCount, heightAfter | 마지막 커밋 완료 (+snapshot) |
| `drop.released` | dropId, startSerial, endSerial, pancakeCount, heightBefore, heightAfter, version | scheduledAt 도달 & READY |
| `drop.delayed` | dropId, scheduledAt, status, pending | scheduledAt 인데 READY 아님 (Drop 당 1회) |
| `drop.failed` | dropId, error | job 재시도 상한 초과 |
| `world.updated` | version, committedPancakes, heightMeters, latestChunkId | job 커밋마다 (클라이언트는 manifest 를 다시 받아 바뀐 chunk 만 갱신) |

클라이언트(world-prototype `src/remote.ts`)는 `drop.released` 를 받으면 manifest 를 갱신하고 `startSerial..endSerial` 의 transform 을 chunk 에서 읽어 DropReplay 로 재생한다. HUD 는 `nextDropAt` 카운트다운과 `queueSize` 를 보여준다.
