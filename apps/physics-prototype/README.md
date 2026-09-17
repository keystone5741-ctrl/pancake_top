# physics-prototype — Phase 0

PANCAKE DROP 플랜 §44 **Phase 0 — Physics Prototype**. 결제 없이 100 → 100,000 장의 팬케이크를 실제로 쌓아 보고, 물리 구조(ACTIVE / SURFACE / FROZEN)와 팬케이크 Geometry 를 확정하기 위한 측정 도구다.

결과와 결론: [`docs/benchmarks/phase0-2026-09-17.md`](../../docs/benchmarks/phase0-2026-09-17.md)

## 구성

```text
src/sim/        렌더러와 무관한 시뮬레이션 코어 (Rapier). 브라우저와 Node 가 같은 코드를 쓴다.
  TowerSim.ts   Drop 스폰 → 낙하 → 정착(SURFACE) → 묻힘(FROZEN), Release(붕괴), 높이맵
  types.ts      SimConfig 와 기본값 (세계 규칙 파라미터)
src/render/     Chunk 단위 InstancedMesh 렌더러 (Three.js)
src/main.ts     브라우저 앱: 카메라, UI, 측정 오버레이, 자동 벤치마크 모드
bench/run.ts    Node 헤드리스 벤치마크 (서버 Physics Worker 관점)
bench/browser.ts Playwright 로 브라우저 자동 벤치마크 수집
```

## 실행

```bash
pnpm install
pnpm --filter physics-prototype dev        # http://localhost:5173  (실제 기기 FPS 측정은 여기서)
pnpm --filter physics-prototype bench -- --targets 100,1000,10000 --release
pnpm --filter physics-prototype build && npx tsx bench/browser.ts --targets 1000,10000 --release
```

브라우저 자동 모드: `/?target=10000&auto=1&quality=performance&release=1` — 완료되면 `window.__RESULT` 에 결과, EXPORT JSON 버튼으로 저장.

## 단위

1 world unit = 10 cm. 팬케이크 직경 1.0 (10 cm), 두께 0.1 (1 cm), 중력 −98.1. Rapier 의 허용 오차가 실제 1 mm 가 되도록 맞춘 스케일이다 (1 unit = 1 m 로 두면 두께 1 cm 객체에 대해 오차가 너무 크다). 표시되는 높이는 m 로 환산한다.
