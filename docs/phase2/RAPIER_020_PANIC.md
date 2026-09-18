# Rapier 0.20.0 `removeRigidBody` wasm 패닉 — 최소 재현

Phase 2 §53. Phase 1 에서 연속 시뮬레이션(작은 배치)이 `RuntimeError: unreachable` 로 죽어 `freezeMode:"rebuild"` 우회를 넣었다. 그때는 제품 코드 안에서만 재현했고 원인을 좁히지 못했다. 이번에 **제품 코드와 무관한 순수 Rapier 스크립트**로 재현했다.

- 재현 스크립트: `tests/rapier/remove-frozen-repro.ts` (`pnpm --filter rapier-repro repro -- --mode pure --batch 20 --seed 1`)
- 테스트: `tests/rapier/remove-frozen-repro.test.ts` — 패닉이 **나야** 통과한다. Rapier 를 올려서 패닉이 사라지면 이 테스트가 실패해 우회를 걷어낼 때임을 알린다.
- 환경: `@dimforge/rapier3d-compat` 0.20.0 (npm 최신), Node 22.22, wasm.

## 재현 패턴 (pure)

1. 고정 바닥(cuboid). 얇은 `roundCylinder`(반높이 0.05, 반지름 0.5, 모서리 0.03) 동적 강체를 배치(batch)마다 20개, 탑 위 3 units 에서 0.4 간격으로 스폰. 중력 −98.1, `linearDamping 2`, CCD on, `contact_natural_frequency 30`.
2. 매 step 충돌 이벤트를 읽어, 동적 강체가 **고정 강체에 닿는 순간 `setBodyType(Fixed, false)`** (제품의 시럽 규칙). 잠든 강체도 Fixed 로.
3. 배치의 강체가 모두 멈추면, 표면(최고점)보다 `freezeDepth`(0.6) 아래 묻힌 Fixed 강체를 `world.removeRigidBody()` (제품의 FROZEN).
4. 다음 배치.

## 결과

| 변형 | 결과 |
| --- | --- |
| 기본 (batch 20, 시드 1·2·3) | **패닉** — 2~3 배치, 40~60장, 31~51개 제거 후 |
| batch 500 | **패닉** — 첫 배치 끝(483개 제거) |
| batch 1 | 300장 완주 |
| 제거하지 않음 (`--remove 0`) | 3000장 완주 (시드 1·2) |
| Fixed 로 바꾸지 않고 잠든 dynamic 을 제거 (`--convert 0`) | 1000장 완주 (탑은 안 쌓이지만 제거 자체는 안전) |
| 제거 전에 60 step 더 돌림 (`--settle-steps 60`) | **패닉** |
| `freezeDepth 3` (더 깊이 묻힌 것만 제거) | **패닉** |
| 초소형: 강체 1~5개 순서대로 쌓고 맨 아래 제거 (`--mode minimal`) | 완주 (재현 안 됨) |
| TowerSim `freezeMode:"remove"` (Phase 0.5 경로) batch 20 | **패닉** (시드 1·2) |
| TowerSim `freezeMode:"rebuild"` (현재 제품) batch 20 | 3000장 완주 |

정리하면 **"동적 → `setBodyType(Fixed)` 로 바뀐 강체를, 다른 강체들과 접촉 그래프를 이룬 상태에서 `removeRigidBody` 하면"** 패닉한다. 제거 시점을 늦추거나(60 step), 더 깊이 묻힌 것만 제거해도 같다. 처음부터 dynamic 인 채로 제거하면 안 난다. 강체가 몇 개뿐인 초소형 장면에서는 안 난다(접촉 그래프/아일랜드가 어느 정도 커야 한다).

패닉 메시지는 wasm `unreachable` 뿐이라 Rust 쪽 스택은 없다. 정황상 body type 변경 후 아일랜드/접촉 그래프 정리가 남아 있는 상태에서 제거할 때 내부 인덱스가 어긋나는 것으로 보인다. 확정은 Rapier 소스(디버그 빌드)가 필요하다.

## 제품에 미치는 영향과 우회

- 제품(`pancake-physics` TowerSim, worker)은 `freezeMode:"rebuild"`: FROZEN 은 `setEnabled(false)` 만 하고, 활성 강체가 0 인 배치 경계에서 월드를 새로 만들어 SURFACE 강체만 다시 넣는다. 개별 제거 API 를 쓰지 않는다. Phase 1 100k 회귀표에서 결과 차이 0.02~0.1 %, 속도 동일.
- 서버 worker 는 여기에 더해 spawn 누적 150k 마다 표면으로 재 INIT 하므로 월드 크기가 유한하다.
- 이 문서의 스크립트를 Rapier 이슈로 올릴 수 있다(상류 보고는 Phase 2 범위 밖).
