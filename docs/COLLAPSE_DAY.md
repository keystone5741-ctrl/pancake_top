# COLLAPSE DAY — 월간 붕괴의 날

Design Draft v0.1 — 2026-09-17
상위 문서: [`PRODUCT_PLAN.md`](./PRODUCT_PLAN.md) v0.3 §49

> **Once a month, as the world falls asleep, the tower falls.**

## 0. 요청 원문과 해석

> 추가로 한 달에 한 번씩 각 국가별로 잠드는 시간?(한국 기준 10시 정도)에 한 번 싹 무너뜨리는 날이 있으면 좋겠어.

이 문장에서 읽어낸 요구사항:

| # | 요구 | 해석 |
| --- | --- | --- |
| R1 | 한 달에 한 번 | 월 단위 주기. 한 달 = 하나의 **Season**. |
| R2 | 각 국가별로 잠드는 시간에 | 붕괴 시각은 **국가별 현지 밤 시간**을 기준으로 한다. 하나의 탑이므로, 결국 붕괴가 **밤을 따라 지구를 한 바퀴 도는** 형태가 된다. (원문에 `?`가 있어 확정 요구가 아닌 것으로 보고, 단일 시각 붕괴를 v0으로 둔다 — §4) |
| R3 | 한국 기준 22시 정도 | 기본 현지 시각 **22:00**. 국가별로 조정 가능. |
| R4 | 한 번 싹 무너뜨린다 | 부분 붕괴가 아니라 **탑 전체**가 무너진다. |

이 기능이 만드는 것:

- 월 1회의 **가장 큰 스펙터클**. Drop이 10분 단위의 작은 이벤트라면, Collapse Day는 한 달의 클라이맥스다.
- **월간 리듬**. "이번 달 탑은 어디까지 갔나"라는 새로운 경쟁 단위와, 신규 사용자도 매달 새 탑의 처음부터 참여할 수 있는 기회.
- 밤을 따라 도는 붕괴는 그 자체가 **전 세계 동시성**을 시각화한다 (v1).

---

## 1. 기존 원칙과의 충돌

Collapse Day는 v0.2의 세 가지 핵심 약속과 정면으로 부딪힌다. 그냥 붙이면 제품이 깨지므로, 각각을 어떻게 해소하는지 먼저 정한다.

### 충돌 1 — §7 "탑이 무너지지 않는 구조"

v0.2의 §7은 탑이 **갑자기, 물리적 사고로** 무너지는 것을 막기 위한 원칙이다. 목적은 부하 감소, 역사 보존, 내 팬케이크 위치 유지다.

**해소:** 붕괴를 물리 사고가 아니라 **서버가 예정한 유일한 세계 이벤트**로 정의한다. Drop 결과나 클라이언트 물리로 탑이 우연히 무너지는 일은 여전히 없다. FROZEN 팬케이크는 Collapse Day의 Release 명령으로만 다시 움직인다. §7의 세 목적 중 "역사 보존"과 "내 팬케이크 위치 유지"는 아래 충돌 3의 해소로 지킨다.

### 충돌 2 — §14 SPACE 100 km 목표

팬케이크 두께를 1 cm로 가정하면 100 km는 완벽하게 쌓아도 **1,000만 개**다. 하루 10만 개(성공한 경우)를 팔아도 한 달에 300만 개, 약 30 km다. **월간 붕괴가 있으면 실제 탑은 절대 100 km에 닿지 못한다.** 이것은 구현 문제가 아니라 제품 결정이다.

**해소 (권장안 A — 누적 적재 높이):** 높이 지표를 둘로 나눈다.

| 지표 | 정의 | 리셋 |
| --- | --- | --- |
| **TOWER HEIGHT** | 이번 Season 탑의 실제 측정 높이 (§13 방식 그대로) | 매달 붕괴 시 0 |
| **TOTAL STACKED HEIGHT** (누적 적재 높이) | 지금까지 모든 Season의 최종 Tower Height의 합 + 현재 Tower Height | 없음 |

SPACE 100 km, Moon 등 §14의 장기 목표는 **TOTAL STACKED HEIGHT**로 판정한다. Cosmic View(§27)는 "무너뜨리지 않았다면 여기까지 왔다"는 **Ghost Tower**(Season별 지층이 쌓인 실루엣)를 보여준다. 이 값은 매 Season 실제 물리로 측정한 높이의 합이므로 §13의 "개수 × 두께로 계산하지 않는다" 원칙과 충돌하지 않는다.

지표 이름(`TOTAL STACKED HEIGHT` / `ALL-TIME STACKED`)은 PO 결정 항목(§9)이다.

**대안 B — 부분 붕괴:** 이번 Season에 쌓인 팬케이크만 떨어지고, 이전 Season의 팬케이크는 영구 Core로 남는다. 실제 탑이 계속 자라므로 100 km가 문자 그대로 가능하지만, "싹 무너뜨린다"(R4)가 아니라 "매달 머리를 깎는다"가 된다. Core가 자라려면 Season 종료 시 그 Season의 팬케이크 중 일부(예: 하위 50%)만 Core로 편입하는 규칙이 필요하다.

**대안 C — 주기 완화:** 붕괴를 분기 1회 또는 "탑이 X km를 넘은 뒤에만"으로 바꾼다. R1을 훼손한다.

권장: **A**. 스펙터클(R4)과 장기 목표를 둘 다 유지하는 유일한 안이다.

### 충돌 3 — §12 Find My Pancake / "모든 물체는 세계에 남는다" / §43 Pancake Destruction 제외

**해소:** 붕괴는 파괴가 아니다. 무너진 팬케이크는

- 같은 `pancake_id`, 국가, Country Serial, Rare를 유지하고,
- 탑 아래 **Fallen Field**에 실제 Instance로 남으며,
- **탑에 서 있던 기록**(Season 번호, 탑에서의 위치, 당시 높이, 무너진 시각)을 Season Archive에 보존한다.

Find My Pancake는 붕괴 후 현재 위치(Fallen Field)로 카메라를 보내고, "Season 3에서 12.41 km 높이에 31일간 서 있었다"를 함께 보여준다. 원한다면 Season Archive를 읽어 **당시 탑을 다시 보기**(Season Replay View)도 가능하다.

---

## 2. 개념 정의

| 용어 | 정의 |
| --- | --- |
| **Season** | 한 달. Season N의 탑은 Season N-1 붕괴 직후의 Opening Drop에서 시작해 Season N의 Fall에서 끝난다. |
| **The Fall / Collapse Day** | Season을 끝내는 붕괴 이벤트. |
| **Release** | 서버가 FROZEN/SURFACE 팬케이크를 ACTIVE로 되돌리는 명령. Collapse Day에만 발생한다. |
| **Collapse Wave** | 한 번에 Release되는 팬케이크 집합의 시뮬레이션 단위. v0은 1개(전체), v1은 국가별 1개. |
| **Fallen Field** | 탑 주변 지면에 무너진 팬케이크가 쌓인 영역. Season이 지날수록 두꺼워진다. 다음 Season 탑은 Fallen Field 중앙 위에서 시작한다. |
| **Season Archive** | 붕괴 직전 탑의 Transform 스냅샷 (읽기 전용 Binary Chunk). |
| **Season Opening Drop** | 붕괴 직후 첫 Drop. 붕괴 준비/진행 중 구매된 팬케이크가 모두 포함되어 월 최대 규모 Drop이 된다. |
| **Replay** | 클라이언트가 재생하는 붕괴 애니메이션 데이터. |

팬케이크 상태 흐름 (v0.2 §6 확장):

```text
FALLING → SETTLING → SURFACE → FROZEN        (탑에서의 일생)
                                  │
                        Collapse Day: RELEASED
                                  ↓
                     FALLING → SETTLING → FALLEN (=FROZEN, Fallen Field)
```

`state` 필드 값: `TOWER` (위 첫 줄 전체) / `RELEASED` (붕괴 진행 중) / `FALLEN`.

---

## 3. 높이와 지표

가정: 두께 1 cm, 직경 10 cm (최종 값은 §13대로 비주얼 확정 후).

| 상황 | 개수 | 완벽 적재 높이 | 비고 |
| --- | --- | --- | --- |
| Alpha 첫 달 | 1만 | 100 m | 건물 스케일 |
| 성공한 달 | 300만 | 30 km | 성층권 |
| SPACE | 1,000만 | 100 km | 월 단위로는 불가 → 누적 지표 필요 |

Fallen Field의 물리적 높이는 매우 낮다. 1,000만 개의 부피는 약 785 m³, 자연 안식각의 원뿔 더미로는 **높이 약 6 m**다. 따라서 Fallen Field는 "지반이 km 단위로 솟는다"가 아니라 **탑 밑에 천천히 넓어지는 팬케이크 언덕**이다. 이 언덕은 실제 Instance로 렌더링한다 (§34의 `fallen/` Chunk).

화면 표시 (권장):

```text
WORLD PANCAKE TOWER
18,482,913 🥞                 ← 누적 개수 (변경 없음)

SEASON 4 TOWER   12.41 km     ← TOWER HEIGHT
ALL-TIME STACKED 82.47 km / SPACE 100 km   ← TOTAL STACKED HEIGHT

THE FALL         3d 04h
```

랭킹 추가:

- **Season Ranking** — 이번 Season 탑에 쌓은 개수 (국가별). 매달 리셋.
- **Season Records** — 역대 Season 최종 높이 순위. "가장 높았던 달".
- All-time Ranking, Country Serial, Rare Milestone은 Season과 무관하게 누적.

---

## 4. 일정과 시각

### 공통

- Season = **달력 월**. Collapse Day = **매월 마지막 날** (PO 결정 항목).
- 기준 현지 시각 = **22:00** (`country.release_local_time`, 기본값, admin에서 국가별 수정).
- 붕괴 `N`일 전 / 1시간 전 / 시작 시점에 알림 (PWA Push, v0.2 §28).

### Option B — v0 (MVP): 전 세계 동시 붕괴

기준 국가의 22:00에 탑 전체가 한 번에 무너진다. 초기 기준은 **KST 22:00 = 13:00 UTC**.

```text
20:50 KST   Season 마지막 정규 Drop
21:00 KST   Season Cutoff. 이후 구매는 Season Opening Drop 대기열로.
            Physics Worker가 붕괴 시뮬레이션 시작 (Snapshot = 21:00 탑)
21:30 KST   UI가 Live Event 모드로 전환. 카메라 연출. "THE FALL 00:30:00"
22:00 KST   THE FALL — 전 세계 동시 Replay 재생
22:10 KST   SEASON OPENING DROP — Cutoff 이후 70분간 구매된 팬케이크 전부
22:20 KST   정규 10분 Drop 재개
```

- Drop 중단은 월 1회, 70분. 이 시간 동안 구매 화면은 `You're in the Season 5 Opening Drop — 00:41:12` 를 보여준다.
- 21:00 Cutoff를 두는 이유: 붕괴 시뮬레이션은 **정확히 최종 상태의 탑**을 입력으로 해야 하고, 수백만 개 Release 시뮬레이션은 실시간으로 끝나지 않기 때문이다. 60분이 부족하면 Cutoff를 앞당긴다 (Phase 0/3b에서 측정).
- 단순하고, 전 세계가 같은 순간을 본다는 점에서 "Every 10 minutes, the world drops together"와 같은 결을 가진다. 단점은 R2(국가별 밤)를 만족하지 못한다는 것: 서울 22시는 뉴욕 오전 9시다.

### Option A — v1: 밤을 따라 도는 붕괴 (Rolling Release)

각 국가의 현지 22:00에 **그 국가의 팬케이크만** Release된다. 붕괴는 UTC+14(키리바시)에서 시작해 UTC−12에서 끝나며, 약 **26시간** 동안 탑이 국가별로 빠져나가면서 서서히 사라진다.

```text
🇰🇷 Korea is asleep.   3,790,182 pancakes fell.        22:00 KST
🇯🇵 Japan is asleep.   3,821,492 pancakes fell.        22:00 JST
...
🇺🇸 USA is asleep.     3,210,201 pancakes fell.        22:00 EST
THE LAST PANCAKE STANDING — 🇧🇷 Brazil #1,981,220       마지막 Wave
```

물리 규칙:

- Release되지 않은 다른 국가의 팬케이크는 **공중에 고정된 채 남는다**. 이것은 §7의 세계 규칙(FROZEN = 공간에 고정)과 일치하며, 탑이 국가별로 구멍이 뚫리며 뼈대만 남는 장면을 만든다.
- 물리적으로 어색하다고 판단되면 **Support Cascade**를 켠다: 어떤 팬케이크의 받침(Settle 시점의 접촉 쌍)이 모두 Release되면 그 팬케이크도 함께 Release. 접촉 그래프는 Drop 시뮬레이션 결과에서 저장한다. 이 옵션은 Phase 0 프로토타입에서 두 가지를 다 만들어 보고 고른다.
- 국가별 Wave가 자연스럽게 시뮬레이션을 26시간에 분산시키므로 v0보다 서버 부하가 오히려 낮다.

미해결 (v1 착수 전 결정):

- **다국가 시간대**: 미국, 러시아, 브라질 등은 대표 시간대 1개를 admin에서 지정한다 (예: US → `America/New_York`). 대안: 대형 국가는 Wave를 시간대별로 나눔.
- **Opening Drop 대기 시간**: v0 규칙(Cutoff 이후 구매는 Opening Drop)을 그대로 쓰면 첫 Wave 국가의 사용자는 최대 26시간을 기다린다. 대안은 (a) 국가별 Opening Drop, (b) 마지막 Wave 전까지는 정규 Drop을 유지하고 새 팬케이크를 Fallen Field 위 새 탑 자리에 쌓기 시작 — 이 경우 아직 서 있는 옛 탑과 새 탑이 공간을 공유하는 문제를 풀어야 한다 (새 탑을 옛 탑 중심에서 살짝 비껴 세우거나, Season마다 탑 자리를 옮기는 "Tower Sites" 개념).
- **국가 미선택/기타 국가** 팬케이크는 마지막 Wave에 포함.

---

## 5. 붕괴 물리와 Replay

v0.2 §8 (서버 Authoritative)과 §9 (Simulation Group 분할)를 그대로 따른다.

### 시뮬레이션

1. **Snapshot**: Cutoff 시각의 탑 (모든 Chunk의 Transform + Settle 시 접촉 그래프).
2. **Release 순서**: Wave 안에서 탑을 **위에서 아래로 Slab** 단위로 나눠 Release한다. 각 Slab은 Simulation Group 크기(예: 2,000~10,000 Active Rigidbody, Phase 0 측정값)로 잘라 순차 시뮬레이션한다. 먼저 떨어진 Slab은 Settle 후 Fallen Field의 SURFACE Collider가 되어 다음 Slab을 받는다.
3. **출력**: 모든 팬케이크의 **최종 Transform** (`fallen/` Chunk) + **Replay Keyframe**.
4. **Archive**: Snapshot을 `archive/season_N/` 으로 이동. DB에는 `season_chunk_id + season_instance_index` 기록.

### Replay 데이터 크기 문제

380만 개 × 10 Hz × 60초 × 28 byte ≈ 64 GB. 모든 팬케이크의 전체 궤적을 전송할 수 없다.

따라서 v0.2 §9의 원칙("데이터는 전부 실제, 애니메이션 품질은 디바이스별")을 적용한다.

- **Hero Set**: 카메라에 가깝거나 큰 움직임을 하는 상위 N개(예: 5만 개, 렌더링 레벨별로 다름)만 실제 Keyframe(10 Hz, 양자화)을 전송한다.
- **나머지**: 클라이언트가 `탑 Transform → 최종 Transform` 사이를 **결정론적 의사 궤적**(Seed 기반 포물선 + 회전)으로 보간한다. 시작점과 끝점은 서버 값이므로 Replay가 끝나면 모든 클라이언트가 동일한 Fallen Field를 본다.
- Rare 팬케이크는 항상 Hero Set에 포함한다.
- Replay는 CDN에서 `replay/season_N/wave_XX.bin` 으로 스트리밍한다.

### 클라이언트 연출 (v0 기준)

```text
21:30   NEXT FALL 00:30:00.  탑 전체가 보이는 원경으로 카메라 이동.
        "SEASON 4 FINAL HEIGHT  12.41 km"  "3,102,884 pancakes"
21:59   카운트다운. 조명 어두워짐(밤).
22:00   THE FALL. 탑 상단부터 무너진다. Rare가 떨어지는 순간 §22와 같은 연출.
22:0x   먼지 가라앉음. Fallen Field 위로 카메라 하강.
        "SEASON 4 IS OVER"
        "ALL-TIME STACKED  70.06 km → 82.47 km"
        "SEASON RANKING  1 🇯🇵 2 🇰🇷 3 🇺🇸"
        "THE LAST PANCAKE STANDING  🇰🇷 Korea #1,008,283"
22:10   SEASON 5 OPENING DROP. 84,201 pancakes.
```

공유 이미지 (§40): `MY PANCAKE STOOD 12.4 KM HIGH FOR 31 DAYS`.

---

## 6. 데이터 구조 추가

```text
season
  season_id
  number                    1, 2, 3 ...
  starts_at                 이전 Season Opening Drop 시각
  cutoff_at                 구매 Cutoff (v0: 21:00 KST)
  fall_at                   붕괴 시각 (v0: 22:00 KST; v1: 첫 Wave 시각)
  opening_drop_at
  status                    ACTIVE | CUTOFF | FALLING | ARCHIVED
  pancake_count
  final_tower_height_m      Snapshot 시점 측정값
  archive_prefix            archive/season_N/

collapse_wave
  wave_id
  season_id
  country                   NULL = 전체 (v0)
  scheduled_at
  snapshot_at
  status                    SCHEDULED | SIMULATING | READY | PLAYED
  pancake_count
  replay_url
  sim_duration_ms           운영 지표

country
  ... 기존 필드
  release_tz                IANA timezone (v1)
  release_local_time        기본 22:00

pancake  (추가 필드)
  season_id
  state                     TOWER | RELEASED | FALLEN
  released_at
  season_chunk_id           붕괴 전 탑에서의 위치 (Season Archive)
  season_instance_index

height_ledger
  season_id
  final_tower_height_m
  total_stacked_height_m    누적 합. SPACE 판정 기준.
```

Transform 테이블(§33)은 **현재 위치**만 담는다. `state = FALLEN` 이면 `fallen/` Chunk를 가리킨다.

Find My Pancake Index(§35)는 `pancake_id → (현재 chunk, season archive chunk)` 두 경로를 유지한다.

---

## 7. 구현 범위와 Phase

| 범위 | 내용 | Phase |
| --- | --- | --- |
| Season 모델 | `season`, `pancake.season_id/state`, Chunk 디렉터리 구조 | Phase 2 (Tower Engine) — 처음부터 포함 |
| Release 측정 | Phase 0 프로토타입에서 10만 개 탑을 한 번에 Release했을 때 Simulation Time, Slab 크기별 비교 | Phase 0 |
| Collapse Engine v0 | Cutoff / Snapshot / Slab Release / Fallen Field Settle / Archive / Replay(Hero Set + 보간) / Opening Drop / NEXT FALL UI | Phase 3b |
| 지표 | TOWER HEIGHT, TOTAL STACKED HEIGHT, Season Ranking, Season Records, Ghost Tower in Cosmic View | Phase 3b |
| 알림 | Collapse Day D-1 / 1시간 전 Push | Phase 6 |
| Collapse Engine v1 | 국가별 Rolling Wave, Support Cascade, 대표 시간대 테이블, Opening Drop 대기 문제 해결 | Phase 7 |

Alpha(Phase 6) 기간에 **최소 1회 실제 Collapse Day를 실행**해 반응(구매 전환, 재방문, 공유)을 측정한 뒤 v1 착수 여부를 정한다.

---

## 8. 리스크

- **결제 직후 붕괴.** 붕괴 하루 전에 산 팬케이크는 탑에 하루만 서 있다가 떨어진다. 구매 화면에 항상 `THE FALL in 3d 04h` 를 표시하고, 붕괴 24시간 이내 구매에는 "이 팬케이크는 Season 5 탑의 첫 층이 됩니다" 같은 안내를 붙여 기대치를 맞춘다. 팬케이크가 사라지지 않는다는 점(§1 충돌 3)을 이용약관과 결제 화면에 명시한다. 붕괴는 환불 사유가 아니다.
- **"탑이 우주에 간다"는 서사의 약화.** 실제 탑은 한 달치 높이다. TOTAL STACKED HEIGHT와 Ghost Tower가 이를 대신하지만, 홈 화면의 첫인상은 12 km 탑이지 82 km 탑이 아니다. PO가 이 트레이드오프를 인지하고 결정해야 한다 (§9 결정 1).
- **Rare 팬케이크의 가시성.** 탑에서 빛나던 Gold Pancake가 Fallen Field에 묻힌다. Rare는 Fallen Field에서도 약하게 빛나게 하고, Season Archive에서 "당시 탑"을 다시 볼 수 있게 한다. 대안: Rare는 붕괴에서 살아남아(Survivor) Fallen Field 중앙 위에 남는다 — 이건 §7 세계 규칙에 또 하나의 예외를 추가하므로 권장하지 않는다.
- **Drop 70분 중단 (v0).** "Every 10 minutes" 약속의 월 1회 예외. 이벤트로 포장한다.
- **시뮬레이션 시간 초과.** Cutoff까지 Replay가 준비되지 않으면 붕괴를 늦출 수 없다(전 세계가 기다린다). Physics Worker에 Wave 단위 시간 예산과 fallback(Slab 크기 확대, Hero Set 축소)을 둔다. Phase 0 측정 결과로 Cutoff 여유를 정한다.
- **v1의 공중 고정 팬케이크.** 물리적 리얼리즘을 기대하는 사용자에게는 이상하게 보일 수 있다. Support Cascade로 완화.

---

## 9. Product Owner 결정 항목

| # | 결정 | 권장 |
| --- | --- | --- |
| 1 | SPACE/Moon 등 장기 높이 목표의 판정 기준 | **TOTAL STACKED HEIGHT** (§1 권장안 A). 대안: 부분 붕괴(B), 주기 완화(C) |
| 2 | 누적 높이 지표 이름 | 문서: `TOTAL STACKED HEIGHT`, UI: `ALL-TIME STACKED` |
| 3 | Collapse Day 날짜 | 매월 마지막 날. 대안: 매월 1일 00:00 직전, 마지막 일요일 |
| 4 | v0 기준 국가/시각 | KST 22:00 (13:00 UTC) |
| 5 | v0 Drop 중단 허용 (70분) | 허용. 이벤트로 포장 |
| 6 | Rare 팬케이크도 함께 무너지는가 | 예. Fallen Field에서도 발광, Season Archive로 당시 모습 보존 |
| 7 | v1 (Rolling Release) 추진 여부 | Alpha에서 v0 1회 실행 후 결정 |
| 8 | 이벤트 명칭 | `THE FALL` (UI) / `Collapse Day` (문서). 한국어: `무너지는 날` |
| 9 | v1의 국가 대표 시간대 규칙 | 국가당 1개, admin 설정 |
