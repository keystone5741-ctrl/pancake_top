# Phase 0.75 — Real Device Performance Gate

2026-09-18 · `apps/physics-prototype` · 물리 규칙 동결 (Natural / Syrup / Drape / Frozen / contactHz 30 / 스폰 로직 / PKT1 포맷 변경 없음)

> **상태: 도구·절차 준비 완료, 실제 기기 측정 미완.**
> 이 세션은 GPU 가 없는 컨테이너(headless Chromium + SwiftShader)에서 실행되어 실제 기기(Windows PC Chrome / iPhone Safari / Android Chrome)에서의 측정을 할 수 없다.
> 아래 §3~§10 의 기기 결과 칸은 사용자가 §1 절차로 수집한 JSON 을 `raw/` 에 넣은 뒤 채운다. Phase 1 진입 조건(§13)은 그 전까지 **미충족**이다.

## 0. 한 줄 요약

- 기기에서 한 번에 돌리는 **Device Suite** 를 만들었다: 기본 100k → 품질 3종 → Find #1/#54321/#99999 → 전체 뷰 → Drop 100/1k/2k/5k → Scale 250k/500k/1M. 단계마다 완전 reload, 브라우저 사망 시 자동 crash 기록, 단계별 체감 등급 입력, JSON 내려받기.
- **높이 지표 분리 결과**: nominal 효율과 geometry-normalized 효율이 모든 크기에서 0.1%p 이내로 같다. 101.3% 는 두께 편차 정의가 아니라 **배치(기울기가 만든 공기층)** 때문이다.
- **Drop 애니메이션용 서버 Transform 파일**: 100k frozen 탑 위에 100 / 1,000 / 2,000 / 5,000 장을 서버 시뮬레이션(frozen 탑은 물리에 넣지 않고 상위 64장만 콜라이더)으로 계산해 파일로 만들었다. 클라이언트는 이 파일을 낙하 연출한 뒤 서버 값에 수렴한다.
- headless SwiftShader 로 스위트 전 단계가 오류 없이 끝까지 도는 것을 확인했다 (§11). 수치는 성능 평가에 쓰지 않는다.

## 1. 기기에서 실행하는 절차

PC 에서:

```bash
pnpm install
pnpm --filter physics-prototype prepare:devices   # 100k 탑 + Drop 파일 생성 (약 1분, git 에 없음)
pnpm proto                                        # http://<PC LAN IP>:5173
```

각 기기의 브라우저에서 `http://<PC LAN IP>:5173/?suite=all` 을 연다 (같은 Wi-Fi). 기기 이름을 입력하면 아래 순서로 자동 진행하며, 단계마다 체감 등급(Good / Acceptable / Poor / Fail)과 메모를 묻는다.

| 순서 | 단계 | 내용 | 스펙 |
| --- | --- | --- | --- |
| 1 | basic | synthetic 100k, standard | §4 |
| 2–3 | quality | synthetic 100k, performance / ultra | §6 |
| 4 | find | 100k 서버 탑 로드 → #1, #54321, #99999 검색. #54321 근접 화면 스크린샷 안내 | §8 |
| 5 | fullview | 100k 전체 뷰. 탑 폭 픽셀 계산. 스크린샷 안내 | §9 |
| 6–9 | drop | 100k + Drop 100 / 1,000 / 2,000 / 5,000 낙하 연출, 수렴 검증 | §10 |
| 10–12 | scale | synthetic 250k → 500k → 1M. 이전 단계가 실패/크래시/Fail 이면 진행하지 않음 | §5 |

끝나면 결과 페이지(`/?suite=results`)에서 **DOWNLOAD JSON** (또는 COPY) 하여 `docs/benchmarks/raw/phase0.75-<기기명>.json` 으로 저장한다. 스크린샷은 `docs/benchmarks/raw/phase0.75-<기기명>-find-54321.png`, `-fullview.png` 로 저장한다.

수집 항목 (JSON 의 각 step.result): average FPS, p95 / p99 frame time, min FPS, freeze events(1초 초과 프레임 수)와 최대 정지 시간, load time, JS heap(Chrome), draw calls, chunk 수, visible instance count, renderer/API(WebGL2, WebGPU 가용 여부), 화면 해상도, DPR, 기기 정보(입력한 이름, platform, UA brands, CPU 코어, deviceMemory), aborted(기기 보호 중단), crashed(reload/사망), grade, note.

브라우저가 죽으면: 같은 주소를 다시 열면 죽은 단계를 `crashed` 로 기록하고 다음 단계로 간다(Scale 이면 더 큰 규모는 `skipped`). 처음부터 다시: `/?suite=all&fresh=1`. 삭제: `/?suite=reset`.

## 2. Height Metric 분리 (§2)

`metrics.height` 에 `geometryM` / `geometryEfficiency` 를 추가했다. 기존 `efficiency` (nominal) 는 유지. 기존 덤프에서 재계산 (`phase0.75-height-metrics.json`):

| 탑 | n | 실측 높이 | nominal (개수 × 1 cm) | nominal 효율 | geometry (실제 두께 합) | geometry 효율 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| natural 100 | 100 | 1.01 m | 1.00 m | 100.7% | 1.00 m | 100.9% |
| natural 1k | 1,000 | 10.13 m | 10.00 m | 101.3% | 9.99 m | 101.3% |
| natural 10k | 10,000 | 101.45 m | 100.00 m | 101.5% | 100.05 m | 101.4% |
| natural 100k | 100,000 | 1,013.50 m | 1,000.00 m | 101.3% | 999.99 m | 101.4% |
| stable 10k | 10,000 | 100.01 m | 100.00 m | 100.0% | 100.01 m | 100.0% |
| loose 10k | 10,000 | 108.41 m | 100.00 m | 108.4% | 99.97 m | 108.4% |

두께 편차는 평균 0 이라 실제 두께 합은 nominal 과 같고, 초과분은 전부 배치에서 온다. Stable(기울기 0.6°) 은 0%, Natural(2.3°) 은 1.3~1.5%, Loose(6°) 은 8.4% — 기울기 중앙값과 단조 관계다.

## 3. Device table (§3)

| 기기 | OS | 브라우저 | GPU (UNMASKED_RENDERER) | 화면 / DPR | 결과 JSON |
| --- | --- | --- | --- | --- | --- |
| Desktop (Windows) | 미측정 | Chrome | | | `raw/phase0.75-<name>.json` |
| iPhone | 미측정 | Safari | | | |
| Android | 미측정 | Chrome | | | |

## 4. 100k performance (§4)

| 기기 | avg FPS | p95 ms | p99 ms | min FPS | load | heap | draw / chunk | visible | backend | crash | freeze | 체감 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: | --- | --- | --- | --- |
| Desktop | 미측정 | | | | | | | | | | | |
| iPhone | 미측정 | | | | | | | | | | | |
| Android | 미측정 | | | | | | | | | | | |

## 5. Maximum usable instance count (§5)

| 기기 | 100k | 250k | 500k | 1M | 마지막 정상 규모 |
| --- | --- | --- | --- | --- | --- |
| Desktop | 미측정 | | | | |
| iPhone | 미측정 | | | | |
| Android | 미측정 | | | | |

## 6. Quality comparison — 100k (§6)

| 기기 | performance FPS / p95 | standard FPS / p95 | ultra FPS / p95 | 체감 |
| --- | --- | --- | --- | --- |
| Desktop | 미측정 | | | |
| iPhone | 미측정 | | | |
| Android | 미측정 | | | |

자동 품질 정책(§6 예시)의 threshold 는 이 표가 채워진 뒤 정한다. 렌더러가 읽을 수 있는 신호: GPU renderer 문자열, `deviceMemory`, `hardwareConcurrency`, DPR, 첫 1초의 실측 frame time. 권장은 "첫 로드 후 2초 실측 p95 로 결정, GPU 문자열은 초기 추정에만 사용".

## 7. 평가 기준 (§7)

수치와 별개로 단계마다 사용자가 입력한 체감 등급을 JSON 에 남긴다. Good = 조작이 부드럽다 / Acceptable = 약간 저하되나 관람·Find 가능 / Poor = 카메라가 끊기거나 입력이 늦다 / Fail = 크래시·reload·정지.

## 8. Find My Pancake (§8)

| 기기 | #1 lookup / fly | #54321 lookup / fly | #99999 lookup / fly | chunk·instance 정확 | 확대 중 FPS | 근접 겹침 육안 | 판정 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Desktop | 미측정 | | | | | | |
| iPhone | 미측정 | | | | | | |
| Android | 미측정 | | | | | | |

lookup 은 `TowerRenderer.locate` (id → chunk = ⌊id/10000⌋ → instance = id mod 10000 → 행렬 읽기) 시간, fly 는 카메라 도착까지. `correct` 는 읽은 위치가 서버 배열 값과 1e−5 이내인지. 판정 기준(스펙 §8): 겹침이 눈에 띄지 않음 → 수정 없음 / 조금 보임 → material·geometry masking 검토 / 명백 → Phase 1 전 visual correction task. Physics 는 재조정하지 않는다.

headless 참고: 세 id 모두 lookup < 0.1 ms, chunk·instance 정확 (§11).

## 9. Tower 전체 뷰 (§9)

| 기기 | 탑 폭 (px, 계산값) | 보임 여부 | AA | 배경 대비 | 깜빡임 | 스크린샷 |
| --- | ---: | --- | --- | --- | --- | --- |
| Desktop | 미측정 | | | | | |
| iPhone | 미측정 | | | | | |
| Android | 미측정 | | | | | |

계산: 전체 뷰 카메라는 탑 중간 높이에서 거리 d = 1.5 × max(2, 0.35 h) 에 있다. 10k units(1 km) 탑이면 d ≈ 5,300 units, 직경 1 unit 은 세로 800 px 화면(FOV 50°)에서 **약 0.16 px × DPR** 이다. 이 값을 `towerWidthPx` 로 JSON 에 기록한다. headless 에서 0.16 px (DPR 1) 로 확인 — 1 px 미만이므로 안티앨리어싱에 따라 희미한 선 또는 아예 보이지 않는다. Phase 1 에서 silhouette / distance exaggeration / atmosphere / height scale visualization 중 선택.

## 10. Drop animation (§10)

서버 측: `pnpm bench --base towers/100000-natural.bin --targets 100,1000,2000,5000` 으로 100k frozen 탑 위에 새 Drop 을 계산했다 (`phase0.75-drops-on-100k.json`). frozen 탑은 물리에 넣지 않고 상위 64장만 fixed 콜라이더로 로드한다 (`TowerSim.loadBase`).

| Drop | 서버 계산 | steps | ms/step | 새 탑 높이 | 침투 max / p95 |
| ---: | ---: | ---: | ---: | ---: | --- |
| 100 | 0.13 s | 116 | 1.11 | 1,014.5 m | 0.24 / 0.107 |
| 1,000 | 0.51 s | 917 | 0.56 | 1,023.6 m | 0.24 / 0.107 |
| 2,000 | 0.86 s | 1,834 | 0.47 | 1,033.7 m | 0.24 / 0.107 |
| 5,000 | 2.00 s | 4,585 | 0.43 | 1,064.1 m | 0.24 / 0.107 |

클라이언트 측 (기기):

| 기기 | Drop | 연출 중 FPS / p95 | 연출 시간 | 수렴 (max pos / quat err) | 밀도 체감 | 발열 | crash |
| --- | ---: | --- | ---: | --- | --- | --- | --- |
| Desktop | 100 / 1k / 2k / 5k | 미측정 | | | | | |
| iPhone | 100 / 1k / 2k / 5k | 미측정 | | | | | |
| Android | 100 / 1k / 2k / 5k | 미측정 | | | | | |

headless 참고 (§11): 4개 Drop 모두 서버 값에 수렴 (pos err 0, quat err ≤ 2e−7).

## 11. headless 절차 검증 (SwiftShader — 성능 수치 아님)

`pnpm --filter physics-prototype suite:headless` 로 스위트 전체를 자동 등급 모드로 실행한 결과 (`raw/phase0.75-headless-swiftshader.json`):

__HEADLESS_TABLE__

## 12. Backend timing risk (§11)

Phase 0.5 값 유지: 100k 계산 p50 44.2 s / p95 44.4 s (단일 스레드 컨테이너). **60초 cutoff 는 프로토타입 임시값이며 Production SLA 가 아니다.** 여유 15~16초는 배포 환경에서 부족할 수 있다. Phase 1 Backend 기본안: 구매가 들어오는 즉시 계속 도는 시뮬레이션에 넣어 대부분의 Transform 을 cutoff 전에 끝내고, cutoff 뒤에는 꼬리만 마무리한다. 10분치 100k 를 마지막 60초에 한꺼번에 계산하는 구조는 최종 구조로 쓰지 않는다. 이번 단계의 `TowerSim.loadBase` 가 그 기반이다: 시뮬레이터가 이전 상태(파일)에서 이어서 쌓을 수 있다.

## 13. Phase 1 진입 조건 점검

| 조건 | 상태 |
| --- | --- |
| Desktop 100k 정상 | ❌ 미측정 |
| iPhone 100k 정상 | ❌ 미측정 |
| Android 100k 정상 | ❌ 미측정 |
| Find My Pancake 3기기 정상 | ❌ 미측정 (headless 는 정상) |
| 브라우저 crash 없음 | ❌ 미측정 |
| Natural preset 이 실제 GPU 에서 예상대로 보임 | ❌ 미측정 |
| 기기별 기본 Quality 정책 데이터 | ❌ 미측정 |
| 실제 기기 benchmark 결과 저장 | ❌ 미측정 (수집 도구·절차·저장 위치 준비됨) |

## 14. Recommended Phase 1 limits (잠정, 기기 데이터 전)

기기 데이터가 없으므로 아래는 구조에서 나오는 상한이며 측정 후 갱신한다.

- 인스턴스 행렬 메모리: 16 float × 4 B = 64 B/장 + 색 12 B → 100k = 7.6 MB, 1M = 76 MB (GPU + JS 양쪽). 모바일 1M 은 메모리보다 fill/vertex 부하가 문제일 가능성이 큼.
- Chunk 10,000 / draw call 1 per chunk: 1M = 100 draw call. 문제 없음.
- 정점 수: standard 16 segment 팬케이크 ≈ 190 tri → 100k = 19M tri/frame. 모바일에서 첫 병목 후보. Performance(8 seg) 는 절반.
- 잠정 기본값: Desktop = standard(ultra 는 측정 후), Mobile = performance 로 시작해 실측 p95 < 33 ms 면 standard 로 승격.

원본: `phase0.75-height-metrics.json`, `phase0.75-drops-on-100k.json`, `raw/phase0.75-*.json`, `raw/*.png`.
