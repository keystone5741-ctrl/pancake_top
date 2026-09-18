# Phase 3A — Event Log & Replay

Phase 3A §17~§20. 코드: `apps/world-server/src/world/eventLog.ts`, `realtime/ws.ts`.

## 테이블 `world_events`

| 컬럼 | 뜻 |
| --- | --- |
| `event_id BIGSERIAL` | 전역 순서. WS 이벤트의 `eventId`, replay 커서 |
| `world_version` | 기록 시점의 world version |
| `type` | 아래 목록 |
| `drop_id` | Drop 이벤트면 |
| `payload JSONB` | WS 로 나가는 본문 그대로 |
| `retain` | true = 감사 이벤트, retention 으로 지우지 않는다 |
| `instance_id` | 기록한 서버 인스턴스 |
| `created_at` | |

`world_events_prune(world_id, pruned_up_to)` 는 retention 이 지운 마지막 event_id (replay 가능 경계).

## 기록하는 이벤트 (§18)

`drop.opened` · `drop.queueUpdated` · `drop.closing` · `drop.ready` · `drop.released` · `drop.delayed` · `drop.failed` · `drop.recovered` · `drop.aborted` · `world.updated` · `simulation.started` · `simulation.completed` · `simulation.failed` · `chunk.committed` · `leader.changed`. 결제/rare 이벤트는 같은 테이블에 type 만 추가한다.

감사(영구) 기본값: `drop.released, drop.failed, drop.aborted, drop.recovered, simulation.failed` (`EVENT_AUDIT_TYPES`).

## 흐름

1. `WorldApp.publish(e)` → `EventLog.append`: INSERT (event_id 발급) → **로컬 구독자에 즉시 배달** → `pg_notify('world_events', event_id)`.
2. 모든 인스턴스는 전용 커넥션으로 `LISTEN world_events`. 알림이 오면 `lastSeen` 이후 행을 event_id 순으로 가져와 배달한다(자기 인스턴스가 쓴 행은 이미 배달했으므로 건너뛴다). 알림이 몰리면 한 번의 fetch 로 합쳐진다.
3. WS 서버는 배달된 이벤트를 자기 클라이언트에 그대로 보낸다 → 어느 인스턴스에 붙어 있어도 같은 순서로 같은 이벤트를 받는다.

`events.lagMsLast/Max` 지표 = 배달 시각 − created_at.

## Replay (§19)

- 접속 시 `world.snapshot` 에 `lastEventId` 가 들어 있다. 클라이언트는 받은 이벤트마다 `eventId` 를 기억한다.
- 재접속: `{ "type": "resync", "lastEventId": N }` →
  - `N ≥ pruned_up_to`: `N` 이후 이벤트를 순서대로 보내고 `{ "type": "resync.done", "lastEventId", "replayed" }`.
  - 아니면 `world.snapshot` (클라이언트는 manifest 를 다시 받는다).
- HTTP 로도: `GET /api/events?after=N&limit=200` (410 = pruned).
- world-prototype `remote.ts` 는 이 프로토콜을 구현한다(중복 eventId 는 무시).

## Retention (§20)

leader 가 60 초마다 `prune()`: `EVENT_RETENTION_HOURS`(24) 보다 오래됐거나 최신 `EVENT_RETENTION_COUNT`(100k) 를 넘는 event_id 중 `retain=false` 를 지우고 `pruned_up_to` 를 올린다. 감사 이벤트는 남으므로 테이블에 "구멍"이 생기지만 replay 는 `pruned_up_to` 기준으로만 허용해 구멍을 재생하지 않는다. 영구 보존이 더 필요하면 `retain=true` 행을 별도 아카이브 테이블로 옮기는 job 을 붙이면 된다(이번 범위 밖).

## 테스트

`tests/events.test.ts`: 순서(started < completed < updated, closing < ready < released), event_id 단조, drop_id/world_version/retain, replay 정확성, retention 뒤 snapshot fallback + 감사 이벤트 보존, 두 인스턴스 사이 LISTEN/NOTIFY 배달(자기 것 중복 없음, lag < 2 s). `tests/cluster.test.ts` 는 leader.changed 순서.
