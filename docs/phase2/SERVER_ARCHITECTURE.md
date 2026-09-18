# Phase 2 — Server Architecture

2026-09-18. `apps/world-server` (Node 22 + TypeScript, 프레임워크 없이 `node:http` + `ws` + `pg`). Phase 2 §1~§4, §21~§26.

## 경계 (§4)

```text
HTTP / WebSocket  (src/http/server.ts, src/realtime/ws.ts)
   │  JSON 만 다룬다. 물리·DB 를 모른다.
   ▼
Application       (src/app.ts  WorldApp)
   │  purchase / tick / 연속 파이프라인. DropCoordinator 규칙(src/drops/coordinator.ts)과 스케줄러(src/drops/scheduler.ts)를 적용한다.
   ▼
Simulation Worker (src/sim/workerClient.ts ⇄ src/sim/worker.ts, 자식 프로세스)
   │  Rapier 는 이 프로세스에만 있다. 메시지는 src/sim/protocol.ts, 바이너리는 PKT1.
   ▼
Tower Engine      (packages/tower-engine: buildChunk / encodeChunk / manifest)
   │
   ▼
Storage           (src/world/worldStore.ts → PostgreSQL + src/world/chunkStorage.ts 로컬 파일)
```

| 계층 | 파일 | 책임 | 모르는 것 |
| --- | --- | --- | --- |
| HTTP/WS | `http/server.ts`, `realtime/ws.ts` | 라우팅, JSON, etag/immutable 캐시 헤더, WS broadcast, `resync` | Rapier, SQL |
| App | `app.ts` | Drop 행 보장, 상태 전이, 구매 → serial 할당, queueUpdated throttle, 연속 시뮬레이션 루프, job 재시도·FAILED, snapshot 주기, 이벤트 발행 | 물리 내부, 파일 형식 |
| Coordinator | `drops/coordinator.ts` | 상태 표 `OPEN → SIMULATING → CLOSING → FINALIZING → READY → RELEASED`, 어디서든 `FAILED`; 표 밖 전이는 `InvalidTransitionError` | 시간 |
| Scheduler | `drops/scheduler.ts` | UTC 10분 경계, `drop_YYYYMMDDTHHMMSSZ` 결정적 id, cutoff, `currentDrop(now)` | DB |
| Serial | `world/serial.ts` | 트랜잭션 안에서 global + country serial 원자 할당, idempotencyKey replay | 물리 |
| Worker client | `sim/workerClient.ts` | `fork` 로 자식 띄우기, 요청/응답 매칭, timeout, crash 감지(`WorkerCrashError`), 재스폰 | 결과 저장 |
| Worker | `sim/worker.ts` | `TowerSim`(Phase 0.5 Natural, `freezeMode:"rebuild"`), INIT(surface PKT1) / SIMULATE_APPEND / SNAPSHOT / PING / DEV_CRASH | DB, HTTP |
| Store | `world/worldStore.ts` | chunk append, 원자 커밋(version+1), manifest, chunk bytes, snapshot, 파일↔DB 정합 | 물리 |
| Storage | `world/chunkStorage.ts` | `ChunkStorage` 인터페이스(put/get/list/remove), `LocalChunkStorage`(tmp+rename), `MemoryChunkStorage`(테스트) | 내용 |

## 프로세스 모델

- **Main** 프로세스: HTTP, WS, DB, 파이프라인. Rapier 를 로드하지 않는다. 절대 죽지 않는다(worker 크래시는 `WorkerCrashError` 로 job 실패 처리).
- **Simulation worker**: `child_process.fork(worker.ts, { execArgv: ["--import","tsx"], serialization: "advanced" })`. 바이너리(Uint8Array)를 구조화 복제로 넘긴다. 크래시(`exit code ≠ 0`)하면 대기 중 요청은 모두 거부되고, 다음 job 이 마지막 안전 상태(job 의 `input_snapshot`, PKT1 상위 K 장)로 새 프로세스를 INIT 한다.
- worker 는 물리 세계에 **표면 조각(상위 `SURFACE_SLICE_SIZE`=512 장)** 만 갖는다. 그중 `SURFACE_TOP_N`=64 장이 콜라이더, 나머지는 높이맵(Frozen 판정)용. 1M 탑을 통째로 물리에 넣지 않는다.
- 누적 spawn 이 150k 를 넘으면 worker 를 현재 표면으로 다시 INIT 해 메모리를 회수한다(`capacity` 200k).

## 연속 시뮬레이션 (§26, §27)

구매가 들어오면 `kick()` 이 루프를 깨운다. 루프는 `committed_serial+1 .. min(latest_global_serial, +SIM_BATCH_SIZE)` 범위를 **한 job** 으로 잡는다(Drop 경계는 넘지 않는다). job = `simulation_jobs` 행 (RUNNING) → worker `SIMULATE_APPEND(count, seed)` → `WorldStore.commit` → DONE. 대기 수가 batch 보다 적으면 `SIM_BATCH_WINDOW_MS` 만큼 모은다. 시드는 `((start·2654435761) mod 2^32) mod 2^31-1` 로 job 범위에서 결정된다(재시도 시 같은 시드).

batch 크기 비교(`bench/batch-policy.ts`, `docs/benchmarks/phase2-server.md`): 10 이면 IPC+커밋 오버헤드가 58 %, 100 이면 36 %, 250 이상은 20 % 대. 기본값 100 은 "구매 후 수백 ms 안에 커밋"과 처리량(≈1.4k 장/s) 의 절충이다.

## 설정 (src/config.ts)

| env | 기본 | 뜻 |
| --- | --- | --- |
| `DATABASE_URL` | `postgres://pancake:pancake@127.0.0.1:5432/pancake_world` | PostgreSQL |
| `PORT` | 8787 | HTTP + WS |
| `DATA_DIR` | `./data` | chunk 파일 (`tower/chunks/000000.chunk`) |
| `DROP_INTERVAL_SECONDS` | 600 | Drop 주기 |
| `DROP_CUTOFF_SECONDS` | 60 | Drop 시각 전 마감 (§28, hardcode 금지) |
| `CHUNK_SIZE` | 10000 | chunk 당 팬케이크 |
| `SIM_BATCH_SIZE` / `SIM_BATCH_WINDOW_MS` | 100 / 250 | job 크기 / 모으는 시간 |
| `SNAPSHOT_EVERY_PANCAKES` | 10000 | 주기 snapshot (§35) |
| `WORKER_MAX_ATTEMPTS` | 3 | job 재시도 상한 (§25, 무한 재시도 금지) |
| `QUEUE_THROTTLE_MS` | 500 | `drop.queueUpdated` throttle (§32) |
| `SURFACE_TOP_N` / `SURFACE_SLICE_SIZE` | 64 / 512 | worker 표면 |
| `DEV_ENDPOINTS` | 1 | `/api/dev/*`, `/dev` |

## 실행

```bash
pg_ctlcluster 16 main start                      # 로컬 PostgreSQL (role pancake / db pancake_world, pancake_test)
pnpm --filter world-server migrate               # 스키마 (idempotent)
pnpm --filter world-server dev                   # http://localhost:8787  (/dev 에 디버그 페이지)
pnpm --filter world-server seed:synthetic -- --count 1000000   # 1M 합성 월드 (물리 없음, 스트리밍 검증용)
pnpm world                                       # world-prototype → ?source=server&server=http://localhost:8787
```

테스트: `pnpm --filter world-server test` (`pancake_test` DB 를 drop/recreate 한다, vitest `pool: "forks"` — 자식 프로세스 IPC 때문).

## 하지 않은 것 (§55)

실제 결제, 로그인, rare 판정, 마켓, Collapse Day, 국가 영토 모드, S3/R2 어댑터(인터페이스만), 다중 서버 인스턴스, 이벤트 replay(재접속은 snapshot).
