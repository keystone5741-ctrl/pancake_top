# Phase 3A — Scaling (Physics Lane, Pipeline, Batch)

2026-09-18. Phase 3A §2~§7. 수치는 `docs/benchmarks/phase3a-infrastructure.md`.

## 원칙: One World → One Authoritative Physics Lane (§3)

PANCAKE WORLD 는 하나의 연속 물리 탑이다. batch N+1 의 결과는 batch N 이 만든 표면(Surface N)에 의존한다.

```text
Surface N → simulate N+1 → Surface N+1 → simulate N+2 → …
```

그래서 물리 상태를 바꾸는 시뮬레이션은 **하나의 lane** 에서 순서대로만 돈다. 서버 인스턴스가 여러 개여도 leader 하나만 시뮬레이션을 orchestration 하고(`MULTI_INSTANCE.md`), leader 는 worker 프로세스 하나를 쓴다.

**금지 (§5)**: 같은 Surface 를 여러 worker 에 주고 batch A, B 를 동시에 계산해 결과를 이어 붙이는 것. `bench/speculative.ts` 가 왜 안 되는지 수치로 보여 준다: 표면이 한 batch 만 어긋나도 다음 batch 의 팬케이크 위치가 전부 달라진다(불일치율은 벤치마크 문서).

## 병렬화하는 것 (§3, §4-B Pipeline) — 구현

물리가 아닌 일은 물리 lane 과 겹쳐 돈다.

```text
worker(Rapier)   : simulate N        | simulate N+1       | simulate N+2
main + thread    :        encode+sha256 N → staging upload N → verify → DB tx N → events N
                                            encode+sha256 N+1 → …
```

- `WorldApp.runJob` (`src/app.ts`): simulate N 의 결과를 받으면 `commitJob(N)` 을 **기다리지 않고** 시작하고(`inflight`), loop 는 곧바로 N+1 을 잡는다. N+1 의 시작 serial 은 `inflight.end + 1`, N+1 job 의 `input_snapshot` 은 worker 가 돌려준 `surfaceAfter(N)`.
- chunk 인코딩과 SHA-256 은 `worker_threads` (`src/world/encodeWorker.ts`) 에서. 저장소 업로드·검증·DB 트랜잭션은 비동기 I/O 라 main 스레드를 거의 쓰지 않는다.
- 커밋은 store mutex 로 직렬화되므로 N+1 의 커밋은 N 의 커밋 뒤에만 시작한다 (world version 단조).
- **N 의 커밋이 실패하면** N+1 의 결과는 잘못된 표면 위에 쌓인 것이므로 버린다(`discardedResults`): job N+1 은 RETRYABLE 로 되돌리고 attempt 를 깎지 않으며, worker 를 N 의 input snapshot 으로 다시 INIT 한 뒤 N 부터 다시 간다. 물리 일관성은 항상 authoritative 커밋 순서가 보장한다.
- 설정: `PIPELINE_OVERLAP=1` (기본). 0 이면 Phase 2 와 같은 순차.

## Worker 안의 O(n) 제거 (§6)

Phase 2 100k 벤치에서 worker 물리 시간이 5k 탑의 34 ms/100장 → 100k 탑의 98 ms/100장으로 늘었던 원인은 물리가 아니라 job 마다 탑 전체를 대상으로 한 작업이었다: 전체 snapshot 을 y 로 정렬해 표면 512 장을 뽑고(`O(n log n)`), 전체 탑의 Stacking 지표를 다시 계산(`O(n)`). Phase 3A: 표면은 min-heap 으로 `O(n log k)`, 지표는 이번 job 분량(+표면 조각)만. 물리 규칙은 그대로다.

## Batch 정책 재검증 (§7)

`bench/batch-policy.ts --overlap 1|0`, batch 10 / 25 / 50 / 100 / 250 / 500 / 1000. 측정: 물리 시간, 인코딩·DB 겹침, end-to-end 지연, 지속 처리량, job p95, Natural 회귀(침투 p95·max, 기울기, 높이, 누출). 결과 표와 결론은 벤치마크 문서. 기본값은 여전히 100 이다: 구매 후 커밋까지 지연 ≈ batch window + job 시간을 유지하면서 처리량이 포화하는 가장 작은 값.

## 처리량 목표 (§6)

목표 ≥ 1,000 장/s (단일 lane, 100k 연속 Drop). Phase 2 는 721 장/s. Phase 3A 의 두 변화(pipeline 겹침, worker O(n) 제거)의 결과는 벤치마크 문서 §2. 물리 결과가 Natural 기준(Phase 0.5 회귀표)을 벗어나면 성능 향상은 채택하지 않는다 — 이번 변화는 물리 코드를 건드리지 않았고 회귀표 값이 같은 범위다.

## 연구 (§4-C Speculative) — production 미사용

`bench/speculative.ts`: authoritative lane 과 별도로, "다른 worker" 가 한 batch 늦은 표면 위에서 다음 batch 를 미리 계산했다고 가정하고 authoritative 결과와 비교한다. 위치 차이 > 0.05 units(0.5 cm) 인 팬케이크가 하나라도 있으면 그 batch 는 재계산해야 한다. 결과(불일치율, 낭비 시간)는 벤치마크 문서 §7. 결론은 그 문서에.
