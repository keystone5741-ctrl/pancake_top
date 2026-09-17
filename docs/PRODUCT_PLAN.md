# PANCAKE DROP

Global Interactive Web Project — Product & Development Plan **v0.3**

## 핵심 문장

**Every 10 minutes, the world drops together.**

전 세계 사람들이 팬케이크를 구매한다.
구매된 팬케이크는 다음 10분 Drop을 기다린다.
정해진 시간이 되면 실제 3D 팬케이크 객체들이 세계 공동의 거대한 팬케이크 탑 위로 떨어지고 쌓인다.
각 팬케이크는 고유 번호, 국가, 위치, 회전값을 가진 하나의 독립된 객체로 남는다.

**그리고 한 달에 한 번, 세계가 잠드는 시간에 탑은 무너진다.** (v0.3 추가 — §49)

## 변경 이력

| 버전 | 날짜 | 내용 |
| --- | --- | --- |
| v0.2 | 2026-09-17 | 기존 Product & Development Plan (Product Owner 작성) |
| v0.3 | 2026-09-17 | 월간 **Collapse Day**(붕괴의 날) 추가. §7, §13, §14, §33, §41, §42, §43, §44, §48 에 관련 항목 반영. 상세 설계는 [`COLLAPSE_DAY.md`](./COLLAPSE_DAY.md) |

> v0.3에서 추가된 내용은 **[v0.3]** 표시를 붙였다. Collapse Day는 기존 원칙(§7 탑이 무너지지 않는 구조, §14 SPACE 목표)과 직접 부딪히는 기능이므로, 충돌 지점과 Product Owner 결정이 필요한 항목을 `COLLAPSE_DAY.md`에 별도로 정리했다.

---

## 1. 프로젝트의 핵심 철학

PANCAKE DROP은 단순한 숫자 카운터가 아니다.

중요한 것은:

> "1,000만 개가 팔렸다."

가 아니라

> "1,000만 개의 팬케이크가 실제로 저기에 쌓여 있다."

라는 감각이다.

따라서 PANCAKE DROP의 핵심 기술·비주얼 원칙을 다음과 같이 설정한다.

### 원칙 1 — 모든 팬케이크는 고유한 객체다.

각 팬케이크에는:

- Global Pancake ID
- Country
- Country Serial
- Drop ID
- Position
- Rotation
- Variant
- Owner/Guest reference

가 존재한다.

### 원칙 2 — 탑 전체를 하나의 가짜 Mesh로 대체하는 것을 기본 방식으로 사용하지 않는다.

사용자가 가까이 접근하면 실제 팬케이크들이 하나씩 존재해야 한다.

### 원칙 3 — 모든 팬케이크가 항상 물리엔진의 Active Rigidbody일 필요는 없다.

실제로 존재하는 것과 계속 물리계산을 하는 것은 다른 문제다.
이미 자리를 잡은 팬케이크는 위치와 회전을 고정하고 렌더링 객체로 유지한다.

### 원칙 4 — 새로운 Drop과 탑의 최상단만 실제 물리 시뮬레이션 대상으로 둔다.

이를 통해:

**실제 객체 + 실제 쌓임 + 대규모 확장**

세 가지를 동시에 최대한 유지한다.

---

## 2. 기본 사용자 경험

홈페이지에 들어오면 별도 설명보다 먼저 거대한 팬케이크 탑이 보인다.

화면에는 다음 정도만 존재한다.

```text
WORLD PANCAKE TOWER
18,482,913 🥞

NEXT DROP
06:42
12,481 pancakes waiting

+ ADD PANCAKE
```

사용자가 팬케이크를 결제하면 즉시 탑에 생기지 않는다.

예:

```text
3 PANCAKES READY
Next Drop
04:28
```

사용자는 다음 Drop을 기다린다.

매시 `:00` `:10` `:20` `:30` `:40` `:50` 마다 전 세계 Drop이 동시에 실행된다.

---

## 3. Drop 시스템

각 10분 구간은 하나의 Batch다.

예: `DROP_20260917_0620UTC`

사용자가 해당 구간에 구매한 팬케이크는 해당 Drop Queue에 등록된다.

Drop 시간 직전에는 짧은 Cutoff를 둔다.

예: Drop 10~30초 전부터 들어온 결제는 다음 Drop으로 자동 이동시킨다.

이를 통해 결제승인 지연과 물리계산 지연 문제를 방지한다.

사용자에게는 명확히 표시한다.

> You're in the next Drop.

---

## 4. 실제 3D 팬케이크 객체

팬케이크는 동일한 기본 Geometry를 사용하는 3D 객체다.

하지만 각각:

- X/Y/Z 위치
- X/Y/Z 회전
- 크기 미세 편차
- 굽기 정도
- 색상 편차
- Variant
- Rare 여부

등을 가질 수 있다.

모든 팬케이크를 각각 별도의 Three.js Mesh로 생성하지 않는다.
대신 **GPU Instancing**을 사용한다.

개념적으로는 `1 Pancake = 1 Object` 이지만 렌더링에서는 `10,000 Pancakes = 1 Instanced Draw Group` 등으로 묶는다.

따라서 사용자 입장에서는 각각 독립된 팬케이크지만 GPU에서는 대량 객체를 효율적으로 처리한다.

---

## 5. Tower Chunk 시스템

팬케이크 탑 전체를 여러 Chunk로 나눈다.

```text
Tower Chunk #00001   Pancake      1 ~  10,000
Tower Chunk #00002   Pancake 10,001 ~  20,000
...
```

각 Chunk는 독립적인 Instance Buffer를 가진다.

Chunk에 저장되는 핵심 데이터:

- Pancake ID
- Position
- Quaternion
- Scale
- Variant
- Country
- Rare Type

카메라에 보이지 않는 Chunk는 렌더링하지 않는다.
가까운 Chunk는 고품질 Geometry를 사용한다.
멀리 있는 Chunk는 저폴리곤 팬케이크를 사용한다.

단, 가능한 범위에서는 각 팬케이크가 독립 Instance라는 구조는 유지한다.

---

## 6. 물리 시뮬레이션 구조

PANCAKE DROP에서 가장 중요한 최적화다.

수백만 개의 팬케이크 모두에게 계속 충돌 계산을 하면 웹에서는 현실적으로 운영하기 어렵다.

따라서 Physics 상태를 세 단계로 구분한다.

| 상태 | 설명 |
| --- | --- |
| **ACTIVE** | 현재 떨어지고 있는 팬케이크. 완전한 Rigidbody. 중력과 충돌을 계산한다. |
| **SURFACE** | 최근에 쌓여 탑의 상단에 존재하는 팬케이크. 새로운 팬케이크와 충돌할 필요가 있으므로 Collider를 유지한다. |
| **FROZEN** | 이미 하단에 묻힌 팬케이크. 위치와 회전은 그대로 유지되지만 더 이상 물리계산하지 않는다. 렌더링은 계속 한다. |

따라서 팬케이크 하나의 흐름은:

```text
FALLING → SETTLING → SURFACE → FROZEN
```

이다.

**[v0.3]** Collapse Day에는 FROZEN 팬케이크가 예외적으로 다시 ACTIVE가 된다(`FROZEN → RELEASED → FALLING → SETTLING → FALLEN`). §49 참고.

---

## 7. 탑이 무너지지 않는 구조

PANCAKE DROP의 목표는 구조물 붕괴 시뮬레이터가 아니다.

탑이 수개월간 쌓였다가 **갑자기** 무너지는 구조는 사용하지 않는다.

따라서 오래된 팬케이크가 FROZEN 상태가 되면 위치가 고정된다.
새 팬케이크는 기존 상단 구조에 쌓이지만 아래 구조 전체를 다시 밀어낼 수 없다.

이를 통해:

- 탑 붕괴 방지
- 서버/클라이언트 부하 감소
- 역사 보존
- 내 팬케이크 위치 영구 유지

가 가능하다.

즉: **물리적으로 떨어지고 쌓이지만, 완전히 자유로운 현실 물리세계는 아니다.**
PANCAKE DROP 세계의 규칙을 가진 물리다.

**[v0.3]** 이 원칙의 유일한 예외는 §49의 **Collapse Day**다.
붕괴는 물리적 사고가 아니라 **서버가 예정한 세계 이벤트**로만 일어난다.
사용자 브라우저나 Drop의 결과로 탑이 우연히 무너지는 일은 여전히 없다.
따라서 이 원칙은 "탑은 **예정되지 않은 방식으로는** 무너지지 않는다"로 읽는다.

---

## 8. 서버 Authoritative Physics

최종 팬케이크 위치는 사용자 브라우저가 결정하지 않는다.
모든 사용자에게 같은 탑이 보여야 하기 때문이다.

따라서 서버가 최종 위치를 결정한다.

```text
구매
→ Drop Queue
→ Physics Worker
→ Final Transform 계산
→ DB/Chunk 저장
→ 모든 Client에 동일 결과 전송
```

최종 Transform (Position X/Y/Z, Quaternion X/Y/Z/W)을 서버가 기록한다.

사용자는 어디서 접속해도 동일한 팬케이크를 본다.

---

## 9. 대규모 Drop 처리

초기에는 한 Drop에 수백~수천 장 정도일 가능성이 높다.

하지만 성공하면 10,000 / 50,000 / 100,000+ 개가 한 번에 구매될 수 있다.

100,000개의 Rigidbody를 모바일 브라우저에서 동시에 계산하는 구조는 사용하지 않는다.

서버 Physics Worker가 Drop을 여러 Simulation Group으로 계산한다.

예: `100,000 Pancakes → 2,000개 × 50 simulation batches`

각 결과를 최종 Tower Transform으로 저장한다.

사용자가 보는 Drop 영상은 실제 100,000개의 신규 객체를 보여주는 것을 목표로 하되 디바이스 성능에 따라 Animation Quality를 조절한다.

- High-end PC에서는 매우 많은 Instance를 직접 보여줄 수 있다.
- 중급 모바일에서는 시각적으로 동일한 Drop을 여러 wave로 표현할 수 있다.

하지만 Drop 종료 후에는 실제 구매된 모든 팬케이크 객체가 Tower 데이터에 존재한다.

---

## 10. 렌더링 목표

- 기본 Renderer: **Three.js**
- 우선 검토: **WebGPURenderer**
- 지원되지 않는 환경: **WebGL2 fallback**

렌더링 레벨을 자동으로 결정한다.

| 레벨 | 내용 |
| --- | --- |
| **Ultra** | 고품질 팬케이크, 높은 Instance 표시량, 그림자, 고급 조명, 많은 Drop 객체 |
| **Standard** | 기본 팬케이크, 중간 수준 그림자, 적절한 Instance 수 |
| **Performance** | 저폴리곤 팬케이크, 단순 조명, 낮은 Drop 동시 애니메이션 수 |

사용자가 직접 변경할 수도 있다.

---

## 11. "모든 팬케이크를 실제로 본다"

PANCAKE DROP의 장기 목표 중 하나다.

사용자가 탑을 확대하면 실제 팬케이크 하나하나를 볼 수 있다.

카메라는 자유롭게 회전 / 확대 / 축소 / 수직 이동 할 수 있다.

다만 매우 먼 거리에서는 팬케이크 하나가 화면의 한 픽셀보다 작아지기 때문에 시각적으로 구분할 수 없다.
따라서 먼 거리에서는 Low Detail Geometry를 사용하되, 데이터상 모든 팬케이크는 그대로 존재한다.

---

## 12. Find My Pancake

결제 후 사용자가 자신의 팬케이크를 찾는 기능이다.

예: `Pancake #18,482,913` — 버튼: **FIND MY PANCAKE**

카메라가 `전체 탑 → 해당 높이 → 해당 Chunk → 해당 팬케이크` 순으로 이동한다.

선택된 팬케이크는 빛, 테두리 또는 작은 Flag로 강조한다.

```text
Pancake #18,482,913
🇰🇷 Korea
Drop        2026.09.17 16:20
Variant     Classic
Tower Height 82.41 km
```

**[v0.3]** 무너진 뒤의 팬케이크도 계속 찾을 수 있다. 붕괴 이후에는 현재 위치(Fallen Field)와 함께 "탑에 서 있던 기록"(Season, 당시 높이, 무너진 날짜)을 표시한다. §49 참고.

---

## 13. 실제 거리 기반 Tower Height

새로운 핵심 콘텐츠로 추가한다.

3D 팬케이크 세계는 실제 길이 단위를 가진다.
즉 팬케이크 모델에는 실제 세계 기준의 직경과 두께를 설정한다.

```text
Diameter   약 XX cm
Thickness  약 X cm
```

정확한 값은 최종 비주얼 디자인 후 확정한다.

물리 Simulation에서 계산된 가장 높은 팬케이크의 실제 Y값을 이용해:

```text
CURRENT TOWER HEIGHT
82.41 km
```

처럼 표시한다.

단순히 `팬케이크 개수 × 두께` 로 계산하지 않는다.
실제로 기울고 겹쳐 쌓인 결과를 반영한 Tower 최대 높이를 사용한다.

**[v0.3]** Collapse Day 도입으로 높이 지표를 둘로 나눌 것을 제안한다(PO 결정 필요, `COLLAPSE_DAY.md` §3).

- **TOWER HEIGHT** — 이번 Season 탑의 실제 높이. 매달 붕괴와 함께 0에서 다시 시작한다.
- **TOTAL STACKED HEIGHT** (누적 적재 높이) — 지금까지 모든 Season의 최종 Tower Height의 합 + 현재 Tower Height. 붕괴에도 줄지 않는 누적 지표다. 각 항이 실제 물리로 측정된 값이므로 "개수 × 두께" 계산이 아니다.

---

## 14. Earth / Space Progress

높이는 서비스의 또 다른 거대한 목표가 된다.

Tower View와 별도로 **HEIGHT MODE**를 제공한다.

```text
Ground
↓ Building Scale
↓ Mountain Scale
↓ Airliner Scale
↓ Stratosphere
↓ 100 km  SPACE
↓ Orbit Scale
↓ Moon
```

사용자는 "지금 팬케이크가 우주 어디까지 왔나?"를 볼 수 있다.

홈 화면에서도 간단하게 `82.4 km / SPACE 100 km` 와 같이 표시할 수 있다.

100 km를 넘는 순간 **WE REACHED SPACE.** 라는 전 세계 이벤트를 발생시킨다.

향후 더 먼 목표도 생성할 수 있다.

이 시스템은 PANCAKE DROP의 장기적인 참여 동기가 된다.

**[v0.3]** SPACE 진행도는 매달 리셋되는 Tower Height가 아니라 **TOTAL STACKED HEIGHT**(§13)를 기준으로 한다. 그렇지 않으면 월간 붕괴와 100 km 목표가 양립하지 않는다(한 달에 1,000만 개를 쌓아야 한다). Cosmic View에는 "무너뜨리지 않았다면 여기까지 왔다"는 Ghost Tower를 표시한다. 자세한 계산과 대안은 `COLLAPSE_DAY.md` §1, §3.

---

## 15. 국가 시스템

MVP에서는 사용자가 직접 국가를 선택한다.

결제창:

```text
Which country are you stacking for?
🇰🇷 Korea
🇯🇵 Japan
🇺🇸 United States
🇧🇷 Brazil
...
```

국적증명은 요구하지 않는다. 위치 권한도 요구하지 않는다.

향후 충분한 데이터가 생기면 `IP 기반 국가 추정 → 기본값 제안 → 사용자 확인` 방식으로 전환할 수 있다.

정확한 GPS 위치는 필요하지 않다. MVP에서는 단순 선택 방식으로 시작한다.

---

## 16. 국가 순위

국가 내부 경쟁은 없다. 세계 전체 국가만 비교한다.

```text
WORLD PANCAKE RANKING
1 🇯🇵 Japan  — 3,821,492
2 🇰🇷 Korea  — 3,790,182
3 🇺🇸 USA    — 3,210,201
4 🇧🇷 Brazil — 1,981,220
```

개인 팬케이크의 Country 정보는 영구 유지한다.

**[v0.3]** 누적 순위(All-time) 외에 **Season 순위**(이번 달 탑에 쌓은 개수)를 추가한다. 국가별 Serial과 Rare Milestone은 Season과 무관하게 누적으로만 진행한다.

---

## 17. Country Serial Number

Global Pancake ID 외에 국가별 번호도 생성한다.

```text
Global Pancake  #18,482,913
Korea Pancake   #1,008,281
```

이 국가별 Serial이 희귀 팬케이크 시스템의 기반이 된다.

---

## 18. 국가별 희귀 팬케이크

희귀 팬케이크는 특정 정확한 번호에 고정하지 않는다.

예를 들어 한국의 100번째 Rare Event는 정확히 #100이 아니라 `#90 ~ #110` 사이의 하나를 서버가 무작위로 결정한다.

예: `Rare position: Korea #103`

실제 사용자는 #103이 나오기 전까지 위치를 알 수 없다.

마찬가지로 큰 Milestone에서는 Window를 설정한다.

```text
Target                 100,000
Possible Rare Window   99,990 ~ 101,000
실제 Rare Number        100,318
```

Window 크기는 Milestone마다 다르게 설정한다.

---

## 19. Rare Milestone 구조

초기 예시: `100 / 1,000 / 10,000 / 100,000 / 1,000,000 / 10,000,000`

각 국가마다 별도로 진행된다.

Korea Gold Pancake, Japan Gold Pancake, USA Gold Pancake는 서로 다른 Country Serial 위치에서 발생한다.

따라서 국가 경쟁에도 새로운 이벤트가 생긴다.

예: `Japan's 1,000,000th Rare Window has started.`

---

## 20. Rare 생성 공정성

운영자가 구매상황을 보고 Rare 위치를 변경하면 안 된다.

따라서 Rare Window가 열리기 전에 Random Seed를 생성하고 결과를 고정한다.

장기적으로는 **Commit / Reveal** 구조를 검토한다.

- Rare Window 시작 전: `hash(randomSeed + country + milestone)` 를 공개.
- Rare 등장 이후 Seed 공개.

누구든 Rare 위치가 사전에 결정돼 있었다는 것을 검증할 수 있게 한다.

---

## 21. Rare 디자인

Rare Pancake는 가격이나 금전적 가치가 아니라 시각적 희귀성을 가진다.

예: Silver / Golden / Burnt / Rainbow / Galaxy / Diamond Pancake

초기에는:

- 현금 환전 불가
- 사용자간 판매 불가
- 투자 가치 표시 금지

를 유지한다.

Rare Pancake도 일반 팬케이크와 동일하게 Tower 안에 실제 객체로 존재한다.
멀리서도 아주 희귀한 팬케이크는 약하게 빛날 수 있다.

---

## 22. Drop 중 Rare 연출

Rare Pancake가 포함된 Drop에서는 바로 공개하지 않을 수도 있다.

Drop이 진행되다가 Rare가 떨어지는 순간 화면 연출이 바뀐다.

```text
GOLD PANCAKE!
🇰🇷 Korea
#100,318
```

처럼 전 세계 사용자에게 표시할 수 있다. 이 장면 자체가 SNS 콘텐츠가 된다.

---

## 23. 전체 UI 구조

**LIVE** — 메인 화면.

- 가장 큰 영역: 3D WORLD PANCAKE TOWER
- 상단: WORLD TOTAL / WORLD HEIGHT / LANGUAGE / PROFILE
- Overlay: NEXT DROP / COUNTDOWN / QUEUE
- 하단: ADD PANCAKE
- 작은 버튼: COUNTRY RANKING / HEIGHT MODE / FIND PANCAKE

**[v0.3]** 상단에 **NEXT FALL** (다음 Collapse Day까지 남은 시간, 예: `THE FALL — 3d 04h`)을 추가한다.

---

## 24. 구매 UI

Bottom Sheet 중심.

```text
ADD PANCAKES
1 🥞   5 🥞   10 🥞   50 🥞   CUSTOM

Country   🇰🇷 Korea ▼
Amount    ₩X,XXX

JOIN NEXT DROP
```

회원가입 없이 결제 가능하게 한다.

---

## 25. 결제 성공

```text
YOU'RE IN

Your Pancakes:
#18,482,913
#18,482,914
#18,482,915

Korea:
#1,008,281
#1,008,282
#1,008,283

Next Drop: 04:21

WATCH DROP   SAVE PANCAKES   SHARE
```

---

## 26. Drop 화면

Drop 30초 전부터 UI가 조금씩 Live Event 모드로 전환된다.

```text
00:30   이번 Drop: 12,482 🥞
00:10   카메라가 탑 상단으로 이동.
3  2  1  DROP
```

하늘에서 팬케이크가 떨어진다.

Drop 후:

```text
12,482 PANCAKES ADDED
New Total     18,495,395
Tower Height  82.41 km → 82.47 km
```

Country changes 표시. Rare가 있었다면 함께 표시.

---

## 27. Cosmic View

3D Tower 화면에서 별도의 버튼을 제공한다: **SEE HOW HIGH WE ARE**

카메라/화면이 지구 거리 스케일로 전환된다.

```text
PANCAKE TOWER
━━━━━━━━━━━━━━
Altitude              82.47 km
Next major milestone  SPACE 100 km
Remaining             17.53 km
```

사용자가 탑을 단순 구매 숫자가 아니라 인류가 같이 만드는 이상한 물리적 구조물처럼 느끼게 한다.

---

## 28. 웹 / 앱 전략

### 1차 — Responsive Web + PWA

핵심 제품이다. 이 프로젝트는 SNS 링크, 즉시 접근, 가입 없는 관람, 빠른 결제, 전 세계 공유가 중요하기 때문에 웹 접근성이 가장 중요하다. 앱 설치를 요구하지 않는다.

### 2차 — Native App

앱이 필요한 주요 이유: Drop Push Notification, 빠른 Tower 접근, 내 Pancake Collection, 반복 이용, Live Drop 관람.

웹에서 제품성이 검증된 후 개발한다.

**[v0.3]** Collapse Day 알림(붕괴 1일 전 / 1시간 전 / 우리나라 차례)은 Push Notification의 가장 강한 사용 사례가 된다.

---

## 29. 기술 Stack

| 영역 | 선택 |
| --- | --- |
| Frontend | Next.js, React, TypeScript, Tailwind CSS |
| 3D | Three.js (WebGPU 우선 검토, WebGL2 fallback) |
| Physics | Rapier 3D / WebAssembly |
| Database | PostgreSQL |
| Realtime | Supabase Realtime 또는 별도 WebSocket layer |
| Queue / Jobs | Redis |
| Physics Workers | Node / WASM Worker service (규모가 커질 경우 별도 Compute Service로 분리) |
| Storage | Object Storage + CDN |
| Monitoring | Sentry |
| Analytics | PostHog |

---

## 30. 프로그램 구조

```text
pancake-drop/

apps/
  web/
  admin/
  physics-worker/

packages/
  ui/
  core/
  database/
  payments/
  tower-engine/
  physics/
  renderer/
  rarity/
  i18n/
  analytics/

services/
  realtime/
  simulation/

docs/
tests/
migrations/
```

**[v0.3]** Collapse Day 로직(Season, Wave 스케줄, Replay 생성)은 `packages/tower-engine` 과 `apps/physics-worker` 안의 하위 모듈로 두고, 별도 패키지는 규모가 커지면 분리한다.

---

## 31. Tower Engine

별도의 핵심 Package로 관리한다.

담당: Tower Chunk / Instance Buffer / Pancake Transform / LOD / Visibility / Height Calculation / Find Pancake / Country Variant / Rare Variant

**[v0.3]** 추가 담당: Season / Fallen Field Chunk / Season Archive / Total Stacked Height

Physics Engine과 Renderer를 직접 섞지 않는다.

---

## 32. Physics Engine

담당: Drop Spawn / Gravity / Collision / Settling / Surface Collider / Freeze / Final Transform

**[v0.3]** 추가 담당: Release (FROZEN → ACTIVE) / Collapse Wave Simulation / Replay Keyframe 출력

Physics 결과만 Tower Engine에 전달한다.

---

## 33. 데이터 구조

### Pancake

```text
pancake_id
global_serial
country
country_serial
order_id
drop_id
variant_id
rarity
chunk_id
instance_index
created_at
season_id        [v0.3]
state            [v0.3]  TOWER | RELEASED | FALLEN
released_at      [v0.3]
```

### Transform

```text
chunk_id
instance_index
position_x / position_y / position_z
rotation_x / rotation_y / rotation_z / rotation_w
scale
```

**[v0.3]** Transform은 "현재 위치"만 담는다. 붕괴 전 탑에서의 위치는 Season Archive(Binary Chunk)에 보존하고, DB에는 `season_chunk_id + season_instance_index` 만 남긴다. Season / Collapse Wave 테이블은 `COLLAPSE_DAY.md` §6.

규모가 작을 때는 PostgreSQL에 저장 가능하다.
수백만~수천만 개가 되면 Transform은 Binary Chunk 파일로 저장하고 DB에는 `chunk_id + instance_index` 를 저장한다.

---

## 34. Chunk Binary Storage

대규모 확장 단계에서는 `chunk_000021.bin` 같은 파일 안에 수천~수만 팬케이크의 Transform을 저장한다.

Position / Quaternion / Variant ID / Country ID 만 Binary 형태로 저장한다. 이를 CDN에서 불러온다.

이 방식으로 수천만 개 객체의 위치정보를 효율적으로 스트리밍한다.

**[v0.3]** Chunk 파일은 Season 단위로 디렉터리를 나눈다.

```text
tower/season_004/chunk_000021.bin    현재 탑
fallen/chunk_000103.bin              Fallen Field (누적)
archive/season_003/chunk_000021.bin  붕괴 전 탑 (읽기 전용)
replay/season_003/wave_KR.bin        붕괴 애니메이션 Keyframe
```

---

## 35. 내 팬케이크 Index

Find My Pancake를 빠르게 하기 위해 `Pancake ID → Chunk ID → Instance Index` Index를 유지한다.

따라서 수천만 개가 있어도 전체 Tower 데이터를 검색할 필요가 없다.

---

## 36. 결제

한국: **Toss Payments** 중심. 지원 목표: 신용/체크카드, 토스페이, 네이버페이, 카카오페이.

해외: International Card → PayPal → 지역 Wallet 순으로 확장.

China Mainland는 별도 프로젝트 수준으로 취급한다.

---

## 37. 언어

- MVP: English / 한국어 / 日本語
- 다음 확장: Português / Bahasa Indonesia / 繁體中文 / Español
- 중국 Mainland 진입 시: 简体中文 추가.

모든 문자열은 i18n JSON으로 분리한다.

---

## 38. 국가 결정 방식

- MVP: 사용자 선택.
- Phase 2: IP 기반 예상 국가 표시. (`Stacking for Korea? YES / CHANGE`)

GPS 위치 권한은 사용하지 않는 방향을 기본으로 한다. 개인정보를 최소화한다.

---

## 39. 사용자 계정

관람에는 계정이 필요 없다. 구매에도 가능하면 계정 가입을 강제하지 않는다.

결제 완료 후 **Save your Pancakes** 를 제공한다.

로그인: Google / Apple / Email 부터 시작한다.

---

## 40. 공유

구매 후 자동 공유 이미지:

```text
I added Pancake #18,482,913
🇰🇷 Korea
Next Drop 4m 22s
```

또는 `MY PANCAKE IS 82.4 KM ABOVE THE GROUND` 같은 콘텐츠를 만들 수 있다.

높이 시스템은 공유 콘텐츠에 매우 적합하다.

**[v0.3]** 붕괴 이후 공유: `MY PANCAKE STOOD 12.4 KM HIGH FOR 31 DAYS` / `KOREA FELL ASLEEP. 3,790,182 PANCAKES FELL.`

---

## 41. 자동 SNS 콘텐츠 소재

프로그램 내부에서 자동으로 이벤트를 탐지한다.

- Largest Drop Ever
- Country Overtake
- Rare Pancake
- Milestone Pancake
- Height Record
- SPACE Milestone
- One Million Pancakes
- 10 Million Pancakes
- **[v0.3]** Season Final Height (붕괴 직전 최종 높이)
- **[v0.3]** Country Release (각 국가 붕괴 순간)
- **[v0.3]** The Last Pancake Standing (마지막으로 무너진 팬케이크)
- **[v0.3]** Season Opening Drop (새 Season 첫 Drop, 월 최대 규모 Drop)

관리자가 바로 Shorts/Reels 콘텐츠로 사용할 수 있게 한다.

---

## 42. MVP에서 반드시 구현

- 3D Pancake Object
- Physical Drop
- Actual Stacking
- Frozen Physics Architecture
- 10-minute Drop
- Unique Pancake ID
- Global Serial
- Country Serial
- User Country Selection
- Country Ranking
- Country Rare Windows
- Rare Pancake
- Tower Height
- Height Mode
- Find My Pancake
- Guest Purchase
- Payment
- English/Korean/Japanese
- Responsive Web
- PWA
- Share
- Admin
- Analytics
- **[v0.3]** Season 모델 (데이터 구조에 처음부터 포함)
- **[v0.3]** Monthly Collapse Day **v0** — 단일 시각 전 세계 동시 붕괴 (`COLLAPSE_DAY.md` §4 Option B)

---

## 43. MVP에서 제외

- Pancake Marketplace
- Cash Resale
- NFT
- Crypto
- Player-to-player Paid Trading
- Pancake Destruction — **[v0.3]** Collapse Day는 팬케이크를 파괴하지 않는다. 무너진 팬케이크도 ID·국가·기록을 가진 객체로 영구히 남는다.
- Enemy Attack
- Country Destruction
- Cities
- Guilds
- Chat
- User Uploaded Images
- Native App Payment
- China Mainland Launch
- **[v0.3]** Collapse Day **v1** — 국가별 취침 시간을 따라가는 Rolling Release (`COLLAPSE_DAY.md` §4 Option A). Public Alpha 이후.

---

## 44. 개발 Phase

### Phase 0 — Physics Prototype

결제 없음. 목표: 100 / 1,000 / 10,000 / 100,000 팬케이크를 실제로 쌓아본다.

측정: FPS / RAM / GPU Memory / Simulation Time / Load Time

이 단계에서 팬케이크 Geometry와 Physics 구조를 확정한다.

**[v0.3]** 같은 프로토타입에서 "쌓인 탑을 한 번에 Release 했을 때"의 Simulation Time도 측정한다. Collapse Engine 설계의 기준 수치가 된다.

### Phase 1 — Million Pancake Rendering Test

물리 시뮬레이션이 아니라 이미 쌓인 객체를 대상으로 100k / 500k / 1M / 5M Instance 렌더링 테스트.

PC / iPhone / Android 각 환경 성능 측정.

이 테스트가 매우 중요하다. 설계 목표를 추측으로 결정하지 않고 실제 Benchmark로 결정한다.

### Phase 2 — Tower Engine

Chunk / Streaming / LOD / Find Pancake / Height 구현.

**[v0.3]** Season 필드와 Fallen Field Chunk 구조를 이 단계에서 함께 잡는다.

### Phase 3 — Drop Engine

10-minute Queue / Physics Worker / Server Authoritative Transform / Freeze System / Realtime Synchronization 구현.

### Phase 3b — Collapse Engine **[v0.3]**

Release System (FROZEN → ACTIVE) / Collapse Wave Simulation / Replay Keyframe / Fallen Field Settling / Season Archive / Season Opening Drop / NEXT FALL Countdown 구현.

MVP 범위는 **v0: 단일 시각 전 세계 동시 붕괴**. 상세: `COLLAPSE_DAY.md`.

### Phase 4 — Rare System

Country Serial / Milestone Window / Random Target / Rare Variant / Audit Seed 구현.

### Phase 5 — Payment

한국 실제 결제 연결. Order / Webhook / Refund / Idempotency / Drop assignment 구현.

### Phase 6 — Public Alpha

한국어 / 영어 / 일본어 동시 지원. SNS를 통해 소규모 공개.

**[v0.3]** Alpha 기간 중 최소 1회의 Collapse Day를 실제로 실행하고 반응을 측정한다.

### Phase 7 — Global Scaling

해외결제 / 추가 언어 / Compute Worker 확장 / CDN / Auto Scaling

**[v0.3]** Collapse Day v1 (국가별 Rolling Release).

---

## 45. Claude 개발 방식

Claude에게 전체 프로젝트를 한 번에 개발시키지 않는다. 각 작업은 별도 Issue 단위로 전달한다.

예:

```text
TASK
Implement Pancake Instancing Benchmark.

GOAL
Determine how many independent pancake instances can be displayed
while maintaining target FPS.

TEST
10k / 100k / 500k / 1M / 2M

DEVICE TARGETS
Desktop / Modern iPhone / Midrange Android

OUTPUT
FPS / Frame time / Memory / Draw calls / GPU timing
```

이 결과를 바탕으로 다음 Architecture를 결정한다.

---

## 46. 개발 관리 역할

| 역할 | 담당 | 내용 |
| --- | --- | --- |
| Product Owner | 사용자 | 컨셉, 브랜드, 최종 디자인, 사업적 결정 |
| Development Manager | ChatGPT | 제품명세, Architecture, Claude Task 작성, 코드리뷰, 성능 검증, DB 검증, 보안 검토, 결제 검토, Scope 관리, 버그 분석, Roadmap 관리 |
| Implementation | Claude Code | Frontend, Backend, Physics, Rendering, Database, Tests, Deployment |

---

## 47. 기술적으로 가장 중요한 원칙

우리는 처음부터 "수백만 개니까 어차피 가짜 탑으로 바꾸자."라고 결정하지 않는다.

먼저 실제 팬케이크 객체를 최대한 많이 유지하는 Architecture를 개발한다.

순서는:

```text
Instancing
→ Chunking
→ Frustum Culling
→ LOD
→ Frozen Physics
→ GPU/WebGPU 최적화
→ Binary Streaming
```

이다. 그 이후에도 성능이 부족한 부분에서만 추가적인 시각적 최적화를 적용한다.

---

## 48. 최종 제품 정의

PANCAKE DROP은 단순한 결제 사이트가 아니다.

전 세계 사람이 소액으로 하나의 물체를 추가한다.
10분마다 그 물체들이 실제로 떨어진다.
모든 물체는 세계에 남는다.
사람들은 자신의 팬케이크를 다시 찾을 수 있다.
나라별로 쌓인 기록이 존재한다.
예측할 수 없는 구간에서 희귀 팬케이크가 나타난다.
탑은 계속 높아진다.

**[v0.3]** 그리고 한 달에 한 번, 세계가 잠드는 시간에 탑은 무너진다.
무너진 팬케이크는 사라지지 않고 탑 아래에 남으며, 다음 탑은 그 위에서 다시 시작한다. 지금까지 쌓아 올린 높이의 합은 줄지 않는다.

그리고 언젠가는 건물을 넘고, 산을 넘고, 대기를 지나, 우주에 도달한다.

프로젝트의 핵심 루프는:

```text
BUY → WAIT → DROP → STACK → FIND → WATCH IT GROW → RETURN
                                                    ↑
                          (monthly)  FALL → REBUILD ─┘   [v0.3]
```

이다.

그리고 모든 기능은 다음 문장을 훼손하지 않아야 한다.

> 전 세계 사람들이 실제 팬케이크를 하나씩 쌓아 어디까지 올라갈 수 있는지 보는 프로젝트.

---

## 49. Collapse Day — 월간 붕괴의 날 **[v0.3]**

> **Once a month, as the world falls asleep, the tower falls.**

### 요청

> 한 달에 한 번씩, 각 국가별로 잠드는 시간(한국 기준 22시 정도)에 탑을 한 번 싹 무너뜨리는 날이 있으면 좋겠다.

### 요약

- 한 달은 하나의 **Season**이다. Season의 마지막에 탑이 무너진다.
- 붕괴는 사고가 아니라 **서버가 예정한 유일한 세계 이벤트**다. §7의 유일한 예외.
- 붕괴 시각은 **각 국가의 현지 22:00**(국가별 설정 가능)을 기준으로 한다.
  - **v0 (MVP)**: 전 세계 동시 붕괴 1회. 기준 시각은 KST 22:00 (= 13:00 UTC).
  - **v1**: 붕괴가 밤을 따라 지구를 한 바퀴 돈다. 각 국가의 22:00에 그 국가의 팬케이크가 Release되어 떨어진다. 마지막 국가가 잠들면 탑은 완전히 사라진다.
- **팬케이크는 파괴되지 않는다.** 무너진 팬케이크는 탑 아래의 **Fallen Field**에 실제 객체로 남고, ID·국가·Rare·"탑에 서 있던 기록"을 영구히 유지한다.
- Fallen Field는 달마다 넓어지는 팬케이크 언덕이다. 다음 Season 탑은 그 중앙 위에서 시작한다.
- 높이 지표는 둘로 나뉜다. **TOWER HEIGHT**(이번 Season, 매달 리셋)와 **TOTAL STACKED HEIGHT**(모든 Season 최종 높이의 합, 누적). SPACE 100 km 목표는 TOTAL STACKED HEIGHT로 판정한다.
- 붕괴 직후 첫 Drop은 **Season Opening Drop**으로, 붕괴 중 구매된 팬케이크가 한 번에 떨어지는 월 최대 규모 Drop이 된다.
- 붕괴 물리는 Drop과 같이 서버 Authoritative로 계산하고, 클라이언트는 미리 계산된 Replay를 재생한다.

상세 설계, 기존 원칙과의 충돌 정리, Product Owner 결정이 필요한 항목은 [`COLLAPSE_DAY.md`](./COLLAPSE_DAY.md) 에 있다.
