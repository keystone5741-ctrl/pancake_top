# physics-prototype — Phase 0 / 0.5

PANCAKE DROP 플랜 §44 **Phase 0 — Physics Prototype** 과 **Phase 0.5 — Physics & Visual Validation** 의 측정 도구.
결제 없이 100 → 100,000 장의 팬케이크를 실제로 쌓아 보고, 물리 구조(ACTIVE / SURFACE / FROZEN)와 세계 규칙(Syrup + Drape)을 검증한다.

결과: [`docs/benchmarks/phase0-2026-09-17.md`](../../docs/benchmarks/phase0-2026-09-17.md), [`docs/benchmarks/phase0.5-2026-09-17.md`](../../docs/benchmarks/phase0.5-2026-09-17.md)

## 구성

```text
src/sim/            렌더러와 무관한 시뮬레이션 코어 (Rapier). 브라우저와 Node 가 같은 코드를 쓴다.
  TowerSim.ts       Drop 스폰 → 낙하 → 정착(SURFACE) → 묻힘(FROZEN), Release, 높이맵, 스냅샷
  types.ts          SimConfig 기본값과 PRESETS (stable / natural / loose)
  metrics.ts        Stacking 품질 계측 (높이·퍼짐·기울기·층 간격·침투)
  towerFile.ts      서버 결과 바이너리 (PKT1): position, quaternion, scale, tscale
  *.test.ts         vitest 단위 테스트
src/render/         Chunk 단위 InstancedMesh 렌더러. id → chunk → instance index 로 Find Pancake.
src/main.ts         브라우저 앱: 물리 모드 / 서버 결과 로드 모드 / 합성 탑 모드, 카메라 뷰, Replay 수렴 검증, 기기 보호
bench/run.ts        Node 벤치마크 (쌓기 + 계측 + 덤프 + Release)
bench/schedule.ts   10분 Drop cutoff 검증: 100k 반복 측정 (p50/p95/실패/RSS)
bench/browser.ts    Playwright 물리 모드 자동 측정
bench/shots.ts      Playwright 프리셋 비교/100k 장면 스크린샷 + Replay 수렴 검증
public/towers/      bench --dump 산출물 (.bin, git 제외). 브라우저 로드 모드가 읽는다.
```

## 실행

```bash
pnpm install
pnpm --filter physics-prototype dev            # http://localhost:5173
pnpm --filter physics-prototype test           # 단위 테스트
pnpm --filter physics-prototype typecheck

# 서버 관점 벤치마크
pnpm --filter physics-prototype bench -- --targets 100,1000,10000,100000 --preset natural --dump 'public/towers/{target}-natural.bin'
pnpm --filter physics-prototype bench:schedule -- --target 100000 --runs 5

# 브라우저 (headless, SwiftShader — 스크린샷/동작 확인용, FPS 는 참고용)
pnpm --filter physics-prototype build && pnpm --filter physics-prototype exec tsx bench/shots.ts
```

## 브라우저 URL 파라미터

| 파라미터 | 뜻 |
| --- | --- |
| `target=100000&auto=1&quality=standard` | 물리 모드 자동 측정. 완료 후 `window.__RESULT`, EXPORT JSON |
| `load=towers/100000-natural.bin` | 서버 결과 파일을 읽어 렌더링만 (물리 없음) |
| `synthetic=1000000` | 물리 없이 절차적으로 쌓은 탑 (실제 기기 렌더링 한계 측정) |
| `view=side\|top\|iso\|full\|mid\|peak\|find:54321` | 카메라 뷰 / Find Pancake |
| `replay=2000` | 로드 모드에서 마지막 2,000 장을 클라이언트 낙하 연출 후 서버 값으로 수렴하는지 검증 |
| `preset=stable\|natural\|loose` | 세계 규칙 프리셋 |
| `release=1` | 물리 모드 완료 후 Release (Phase 0 스트레스 테스트) |

실제 기기 측정 절차: `pnpm dev` 로 띄운 주소를 기기에서 열고 `?synthetic=100000&auto=1&quality=standard` → `500000` → `1000000` 순으로 실행, 각 완료 후 EXPORT JSON. 프레임이 3초를 넘거나 heap 이 한계에 가까우면 앱이 스스로 중단하고 마지막 정상 결과를 남긴다 (`aborted: true`).

## 단위

1 world unit = 10 cm. 팬케이크 직경 1.0 (10 cm), 두께 0.1 (1 cm), 중력 −98.1. Rapier 의 허용 오차가 실제 1 mm 가 되도록 맞춘 스케일이다. 표시되는 높이는 m 로 환산한다.
