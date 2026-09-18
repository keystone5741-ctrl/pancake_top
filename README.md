# PANCAKE DROP

**Every 10 minutes, the world drops together.**

전 세계 사람들이 팬케이크를 구매하고, 10분마다 실제 3D 팬케이크 객체들이 세계 공동의 탑 위로 떨어져 쌓인다. 모든 팬케이크는 고유 번호, 국가, 위치, 회전값을 가진 독립된 객체로 영구히 남는다. 그리고 한 달에 한 번, 세계가 잠드는 시간에 탑은 무너진다.

## 문서

| 문서 | 내용 |
| --- | --- |
| [`docs/PRODUCT_PLAN.md`](docs/PRODUCT_PLAN.md) | Product & Development Plan v0.3 — 철학, UX, 렌더링/물리 구조, 데이터, 결제, 개발 Phase |
| [`docs/COLLAPSE_DAY.md`](docs/COLLAPSE_DAY.md) | 월간 붕괴의 날(Collapse Day) 설계 초안 — 기존 원칙과의 충돌 정리, v0/v1 일정, 물리·Replay, 데이터, PO 결정 항목 |
| [`docs/IDEA_TERRITORY_DROP.md`](docs/IDEA_TERRITORY_DROP.md) | 아이디어: 국가 영토 위로 떨어지는 팬케이크 (단일 탑과의 비교, 스케일 조절, PO 결정 항목) |
| [`docs/benchmarks/phase0-2026-09-17.md`](docs/benchmarks/phase0-2026-09-17.md) | Phase 0 물리 프로토타입 측정 결과와 결론 |
| [`docs/benchmarks/phase0.5-2026-09-17.md`](docs/benchmarks/phase0.5-2026-09-17.md) | Phase 0.5 물리·시각 검증: 품질 계측, 프리셋 비교, Drop 스케줄링, 실제 기기 절차 |
| [`docs/benchmarks/phase0.75-real-devices.md`](docs/benchmarks/phase0.75-real-devices.md) | Phase 0.75 실제 기기 성능 게이트: Device Suite 실행 절차, 결과 표(기기 측정 대기), 높이 지표 분리, Drop 애니메이션 |
| [`docs/phase1/ARCHITECTURE.md`](docs/phase1/ARCHITECTURE.md) · [`TOWER_ENGINE.md`](docs/phase1/TOWER_ENGINE.md) · [`CONTINUOUS_DROP.md`](docs/phase1/CONTINUOUS_DROP.md) | Phase 1 World Engine 설계: 패키지 의존 방향, Chunk/인덱스/스트리밍, 연속 Drop 시뮬레이션과 발견한 버그 |
| [`docs/benchmarks/phase1-world-engine.md`](docs/benchmarks/phase1-world-engine.md) | Phase 1 벤치마크: 100k/500k/1M 구조, 연속 시뮬레이션, 증분 vs 일괄, 물리 회귀표, 원거리 비교 |

## 코드

```text
apps/world-prototype/     Phase 1 — World Engine 검증 앱 (chunk 스트리밍, LOD, Find, Height Mode, Continuous Drop, Replay)
apps/physics-prototype/   Phase 0/0.5/0.75 — 물리 프로토타입과 벤치마크 (재현용 유지)
packages/pancake-core/    공용 타입, 단위 변환, Height Milestone
packages/pancake-physics/ 물리 코어(TowerSim), 계측, ContinuousDropSimulator
packages/tower-engine/    Chunk, 인덱스, 높이, 가시성, 스트리밍, .chunk 바이너리
packages/pancake-renderer/ Three.js InstancedMesh 렌더러, LOD, QualityManager, 실루엣, DropReplay
packages/pancake-navigation/ 카메라 모드, Find, 고도 내비게이터
```

```bash
pnpm install
pnpm world        # World prototype  http://localhost:5174  (?synthetic=100000 · ?synthetic=1000000 · ?find=54321 · ?drop=5000)
pnpm proto        # Physics prototype http://localhost:5173
pnpm typecheck && pnpm test && pnpm build
```

아키텍처: [`docs/phase1/ARCHITECTURE.md`](docs/phase1/ARCHITECTURE.md)

## 현재 상태

**Phase 0 / 0.5** 완료, **Phase 0.75** 도구 준비 완료(실제 기기 측정 대기), **Phase 1 — Core World Engine** 구현 완료 (플랜 §44). 기기에서 `pnpm proto` 후 `/?suite=all` 을 실행해 결과 JSON 을 `docs/benchmarks/raw/` 에 저장하면 게이트를 판정한다. 그 다음이 Phase 1 — Million Pancake Rendering Test (실제 기기에서 100k~5M Instance 렌더링 측정). 각 작업은 §45의 방식대로 별도 Issue 단위로 진행한다.

## 개발 역할 (§46)

- **Product Owner** — 컨셉, 브랜드, 최종 디자인, 사업 결정
- **Development Manager** — 명세, Architecture, Task 작성, 리뷰, 검증
- **Implementation** — Claude Code: Frontend, Backend, Physics, Rendering, Database, Tests, Deployment
