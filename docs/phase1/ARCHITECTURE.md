# Phase 1 — World Engine Architecture

2026-09-18. 플랜 §30~§32 의 구조를 실제 패키지로 옮긴 결과.

## 패키지와 의존 방향

```text
apps/world-prototype ──▶ pancake-navigation ──▶ pancake-renderer ──▶ tower-engine ──▶ pancake-core
        │                                              ▲
        └──▶ pancake-physics ──────────────────────────┘ (pancake-core 만 의존)

apps/physics-prototype ──▶ pancake-physics, pancake-core   (Phase 0/0.5/0.75 재현용, 유지)
```

| 패키지 | 역할 | 의존 |
| --- | --- | --- |
| `pancake-core` | 공용 타입(PancakeId, DropId, ChunkId, CountryCode, VariantId, PancakeTransform, PancakeMetadata, PancakeTransformSet), 실제 단위 변환(`worldUnitsToMeters`, `metersToWorldUnits`, `formatHeight`), Height Milestone API | 없음 |
| `pancake-physics` | Phase 0 물리 코어(TowerSim, Natural preset, 시럽·드레이프·Frozen), Stacking 계측, PKT1 결과 파일, SurfaceColliderProvider, ContinuousDropSimulator | core, Rapier |
| `tower-engine` | Chunk(설정 가능한 chunkSize), 인덱스(serial→chunk→instance, O(1)), 높이(source of truth = chunk header), 절두체 가시성, 스트리밍 상태 결정, 합성 탑, `.chunk` 바이너리 + manifest + UrlChunkSource | core |
| `pancake-renderer` | Three.js: QualityManager(preset 중앙 관리), 3단계 LOD 지오메트리, chunk 별 InstancedMesh 세트, 화면 크기 기반 LOD 분배, chunk 컬링, 하이라이트, 실루엣 보조, DropReplay | core, tower-engine, three |
| `pancake-navigation` | CameraRig(explore / fullTower / top / findPancake / heightMode), 비행 계산, reduced-motion, 고도 내비게이터 눈금, Find 흐름 | core, tower-engine, renderer, three |

순환 의존 없음. 물리(`pancake-physics`)와 렌더러는 서로 모른다: 물리 결과는 `PancakeTransformSet` 으로만 전달되고(플랜 §8, §31, §32), 렌더러는 `InstanceSource`/chunk transform 배열만 읽는다.

## 데이터 흐름

```text
구매 → ContinuousDropSimulator (서버)          ┐ pancake-physics
      → DropResult.finalTransforms (PancakeTransformSet)
      → MemoryChunkSource.append / .chunk 파일 + manifest   ┐ tower-engine
      → Tower (headers: 높이·가시성·인덱스, chunks: transform)
      → ChunkRenderer (상태 전환, LOD, 컬링)                ┐ pancake-renderer
      → DropReplay (연출 후 서버 값으로 수렴)
      → CameraRig / Find / Height Mode                       ┐ pancake-navigation
```

## 핵심 불변 조건

1. **모든 팬케이크는 실제 객체.** 어떤 LOD 에서도 1 팬케이크 = 1 instance. chunk 는 렌더 단위일 뿐 팬케이크를 합치지 않는다 (`ChunkMeshSet`).
2. **높이의 source of truth 는 chunk header (서버 값).** HUD, Height Mode, 고도 내비게이터가 모두 `Tower.heightMeters` 를 읽는다. 가짜 카운터 금지 (테스트 `heightScale.test.ts`).
3. **서버 final transform 은 클라이언트 연출이 바꾸지 않는다.** DropReplay 는 렌더 행렬만 바꾸고 끝나면 서버 값으로 되돌린다 (테스트 `dropReplay.test.ts`, 오차 0).
4. **물리 규칙 동결.** Natural / 시럽 / 드레이프 / Frozen / contactHz / 스폰 로직 / PKT1 은 Phase 0.5 그대로. Phase 1 에서 바뀐 것은 Rapier body 정리 방식(`freezeMode: rebuild`)과 바닥에 파묻힌 팬케이크 처리뿐이며 둘 다 버그 수정이다 (`CONTINUOUS_DROP.md`, 회귀표는 `benchmarks/phase1-world-engine.md`).

## 실행

```bash
pnpm install
pnpm world                       # apps/world-prototype  http://localhost:5174
pnpm proto                       # apps/physics-prototype (Phase 0 도구)
pnpm typecheck && pnpm test && pnpm build
```

world-prototype URL: `?synthetic=100000` · `?synthetic=1000000` · `?find=54321` · `?drop=5000` · `?view=full|top|height|alt:500` · `?far=pure|silhouette|atmospheric|both` · `?quality=performance|standard|ultra` · `&auto=1` (측정 후 `window.__RESULT`) · `&shot=1` (UI 숨김).
