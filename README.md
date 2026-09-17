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

## 코드

```text
apps/physics-prototype/   Phase 0 — 물리 프로토타입 (Three.js + Rapier). 브라우저 앱 + Node 벤치마크
```

```bash
pnpm install
pnpm proto        # 브라우저 프로토타입 (http://localhost:5173)
pnpm bench        # Node 헤드리스 물리 벤치마크
```

## 현재 상태

**Phase 0 — Physics Prototype** 구현 및 1차 측정 완료 (플랜 §44). 다음은 Phase 1 — Million Pancake Rendering Test (실제 기기에서 100k~5M Instance 렌더링 측정). 각 작업은 §45의 방식대로 별도 Issue 단위로 진행한다.

## 개발 역할 (§46)

- **Product Owner** — 컨셉, 브랜드, 최종 디자인, 사업 결정
- **Development Manager** — 명세, Architecture, Task 작성, 리뷰, 검증
- **Implementation** — Claude Code: Frontend, Backend, Physics, Rendering, Database, Tests, Deployment
