# Phase 3A — Multi-instance Server

Phase 3A §21~§25. 코드: `apps/world-server/src/cluster/leader.ts`, `app.ts` (`claimJob`, `onLeaderChange`).

## 구조

```text
            ┌── Server A (HTTP/WS, purchases)  ── leader: scheduler · coordinator · simulation ── worker A
clients ──▶ │                                   PostgreSQL (advisory lock, jobs, events, world)
            └── Server B (HTTP/WS, purchases)  ── follower: 조회/구매/WS 만
```

- **모든 인스턴스**: `/api/*`, `/ws`, 구매(serial 할당은 DB 트랜잭션이라 원자적), manifest/chunk 서빙, 이벤트 broadcast(LISTEN).
- **leader 만**: Drop tick(CLOSING/READY/RELEASED), 시뮬레이션 루프(worker 프로세스), snapshot, event retention.
- 물리 lane 은 여전히 하나다(`SCALING.md`). 인스턴스를 늘리는 것은 HTTP/WS 용량과 가용성을 위한 것이다.

## Leader 선출 (§22)

`LeaderElector`: 전용 `pg.Client` 로 `pg_try_advisory_lock(hashtext('pancake-leader:<world>'))`. 세션 락이라 **커넥션이 살아 있는 동안만** 유지되고, 프로세스가 죽으면 서버가 커넥션을 정리하면서 락이 풀린다. `LEADER_LEASE_MS`(5 s) 마다 poll: follower 는 락을 시도하고, leader 는 `leader_lease`(instance_id, term, heartbeat_at) 를 갱신한다(관측용). 락 커넥션에 오류가 나면 즉시 leader 를 내려놓는다(`onLeaderChange(false)`: tick/prune 타이머 정지, loop 는 다음 반복에서 멈춤).

split-brain 이 없는 이유: 락은 PostgreSQL 이 단 하나에게만 준다. 네트워크 분단으로 leader 가 DB 를 못 보면 락 커넥션도 끊기므로 leader 자격을 잃고, 그 상태에서 한 in-flight 커밋은 `world_state.version` 조건부 UPDATE 로 거부된다.

## Failover (§23)

죽은 leader 의 락이 풀리면 다음 poll 에서 다른 인스턴스가 잡는다(≤ `LEADER_LEASE_MS`). 새 leader 는 `store.refresh()` → `recoverJobs()`(lease 만료 RUNNING → RETRYABLE) → 현재 Drop 보장 → tick 시작 → `leader.changed` 이벤트 → 파이프라인 재개. 같은 Drop id(시각 결정적)를 그대로 이어간다.

측정: `tests/cluster.test.ts`(in-process, 락 커넥션 강제 종료) 와 `bench/dual-server.sh`(실제 프로세스 kill -9). 수치는 벤치마크 문서 §5~§6.

## Job claim (§25)

`simulation_jobs` 에 `owner`, `lease_expires_at`. claim 은 하나의 UPDATE:

```sql
UPDATE simulation_jobs SET status='RUNNING', owner=$me, lease_expires_at=now()+lease, attempt=attempt+1
WHERE job_id = (… 같은 범위의 최신 non-DONE job …)
  AND (status IN ('PENDING','RETRYABLE') OR (status='RUNNING' AND lease_expires_at < now()))
RETURNING *
```

0행이면 다른 인스턴스가 lease 안에 들고 있는 것 → 건너뛴다(`claimConflicts`). 새 job 은 INSERT 시점에 owner/lease 를 함께 넣는다. 시뮬레이션 중 `JOB_LEASE_MS/3` 마다 lease 를 연장하고, DONE/RETRYABLE 로 갈 때 owner/lease 를 비운다. 실패 표시 UPDATE 는 `WHERE owner = $me AND status = 'RUNNING'` 이라 이미 다른 인스턴스가 회수한 job 을 건드리지 않는다. 이중 실행이 일어나도(lease 만료 직후 옛 owner 가 커밋 시도) `world_state.version` 검사와 `commit out of order` 검사가 두 번째 커밋을 거부한다.

## Serial 할당 (§24)

Phase 2 그대로: `world_state FOR UPDATE` 안에서 global + country serial. 인스턴스 수와 무관. `tests/cluster.test.ts` 가 두 인스턴스에서 동시에 1,000 주문(국가 KR/JP/US/BR/ID/ZZ)을 넣어 global 연속·country 연속·idempotency 를 검증하고, `bench/dual-server.sh` 가 HTTP 로 두 서버에 라운드로빈 부하를 건다.

## 설정

| env | 기본 | 뜻 |
| --- | --- | --- |
| `INSTANCE_ID` | `<hostname>-<pid>` | 로그/lease/이벤트의 인스턴스 이름 |
| `LEADER_LEASE_MS` | 5000 | 선출 poll / heartbeat 주기 → failover 상한 |
| `JOB_LEASE_MS` | 60000 | RUNNING job 회수 대기. worker crash 뒤 새 leader 가 그 job 을 다시 잡기까지의 최대 지연 |

## 남은 것

- 인스턴스별 worker 는 leader 만 쓰므로 follower 의 worker 는 spawn 되지 않는다(레이지).
- 하나의 PostgreSQL 이 SPOF 다. HA PostgreSQL(managed) 은 인프라 선택 사항.
- 스티키 세션은 필요 없다(이벤트가 DB 로 동기화되고, 재접속은 resync).
