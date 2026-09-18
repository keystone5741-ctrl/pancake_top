# Continuous Drop Simulation

`packages/pancake-physics/src/continuous.ts`. Phase 0.75 의 "100k frozen 위 +5,000 = 2초" 구조를 서버 프로토타입으로 발전시킨 것 (Phase 1 §18~§24).

## 상태 (§19)

```text
OPEN ──enqueue──▶ SIMULATING ──closeDrop──▶ CLOSING ──(남은 계산)──▶ FINALIZING ──(모두 정착)──▶ READY ──releaseDrop──▶ RELEASED
```

- `createDrop()` 은 이전 Drop 이 닫힌 뒤에만 가능. 구매는 `enqueuePancakes(dropId, n)` 으로 **즉시** 큐에 들어가고 serial 을 받는다. cutoff 뒤의 구매는 다음 Drop 에 넣는다.
- `processPending(budgetMs)` 를 서버 루프가 계속 호출한다. 물리에는 `batchSize`(500) 단위로만 공급한다: 한 배치가 정착한 뒤 다음 배치를 넣는 Phase 0.5 조건을 구매 도착 패턴과 무관하게 유지하기 위해서다 (10k 를 한 번에 큐에 넣으면 공중의 활성 기둥이 커져 침투 최대 1.05 두께까지 나빠졌다).
- `finalizeDrop()` 은 남은 계산을 동기로 끝낸다. `getDropResult()` = `{ dropId, total, startSerial, endSerial, finalTransforms, heightBefore, heightAfter, simulationMs }`.
- **물리 시간 ≠ 시각 시간 (§20).** READY 는 계산 완료, RELEASED 는 사용자에게 보여 주는 시각. 클라이언트 애니메이션은 history playback 이다 (`DropReplay`).

## Surface Collider Provider (§22)

`getSurfaceColliders(tower)` 가 fixed 콜라이더로 둘 팬케이크를 고른다. 기본 `TopNSurfaceProvider(64)`(Phase 0.75 방식), 대안 `HeightBandSurfaceProvider(depth)`(최고점에서 depth 안의 전부). frozen 탑은 물리에 넣지 않는다 (`TowerSim.loadBase`).

## 발견한 버그와 수정 (물리 규칙 변경 아님)

### 1. Rapier 0.20 wasm 패닉 (`unreachable`)

작은 배치(10~22장, 일부 35장) 패턴에서 Phase 0/0.5 의 FROZEN 처리(`removeRigidBody`)가 wasm 패닉을 일으켰다. 시드 6개 중 5개, 배치 12~22 에서는 시드 전부. 배치 500(Phase 0.5) 이나 1·5·8·25~30 에서는 나지 않아 지금까지 드러나지 않았다. 구매가 몇 장씩 들어오는 연속 시뮬레이션에서는 반드시 만나는 경로다.

시험한 것: 제거 지연(2 step), idle 시 제거, `setBodyType(wakeUp=true)`, 접촉 중 body 제거 금지 가드, CCD off, sentinel 강체 — 모두 어느 시드에서든 다시 났다. **개별 제거 API 를 아예 쓰지 않는 것만 안전했다.**

채택 (`freezeMode: "rebuild"`): FROZEN 은 `setEnabled(false)` 로 비활성화만 하고, 활성 강체가 0 인 배치 경계에서 Rapier 월드를 새로 만들어 SURFACE body(수십 개)만 다시 넣는다. 동적 강체가 없는 시점이므로 물리 상태 손실이 없다.

| 항목 | remove (Phase 0.5) | rebuild |
| --- | --- | --- |
| 30/20 패턴 시드 10개 | 9 크래시 | 0 |
| 배치 12/20/35 × 시드 3 | 8 크래시 | 0 |
| 20k 시뮬레이션 시간 | 8.57 s | 8.49 s |
| 20k 최대 body 수 | 7 | 508 |
| 20k 높이 / 기울기 median / 침투 max | 202.844 m / 2.2888° / 0.1841 | 202.889 m / 2.2884° / 0.1833 |

결과 차이(0.02%)는 배치 안에서 비활성 body 가 솔버 순서에 남기 때문이다. 100k 회귀표는 `benchmarks/phase1-world-engine.md`.

`disable`(제거 없음, 재생성 없음) 도 크래시가 없지만 body 가 10만 개 쌓여 100k 계산이 79 s 로 2배 느려져 채택하지 않았다. `remove` / `deferRemove` / `disable` 은 옵션으로 남긴다.

근본 원인은 Rapier 내부라 확정하지 못했다(최신 버전 0.20.0). 정황: 동적 강체와 접촉 쌍이 있던 고정 body 의 제거. 리스크로 남긴다.

### 2. 바닥에 파묻힌 채 멈춘 팬케이크

탑에서 떨어져 바닥에 부딪힌 팬케이크가 중심 y ≈ 0(반두께 0.05 미만)에서 잠들면 "바닥 위" 조건을 못 넘겨 영원히 ACTIVE 로 남고 배치가 끝나지 않았다(Phase 0.5 임계값 0.045 근처의 잠재 버그). 잠들었거나 느린 강체가 바닥 아래면 바닥 위로 스냅해 정착시킨다.

회귀 테스트: `TowerSim.test.ts` "small consecutive batches do not crash", `continuous.test.ts`.

## 벤치마크 (§23, §24)

`apps/physics-prototype/bench/phase1.ts`. 결과는 `benchmarks/phase1-world-engine.md`.
