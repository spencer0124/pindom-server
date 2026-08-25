# 2026-08-22 — 앱 개발자용 인수 문서

> 백엔드가 `pindom-1234` 에 전부 배포돼 있다. 이 문서 하나로 **무엇이 올라가 있고, 앱이 어떻게
> 붙이고, 계약서와 무엇이 달라졌는지** 확인할 수 있다. 필드 이름의 최종 심판은 여전히 앱 레포의
> [`backend-contract.md`](https://github.com/spencer0124/pindom/blob/main/docs/reference/backend-contract.md)
> 이며, 이 문서는 그 위에 얹힌 **실제 배포 상태와 차이점**이다.

## 지금 상태

| 항목 | 상태 |
| --- | --- |
| Firestore 규칙 | 배포됨 |
| Storage 규칙 | 배포됨 |
| 복합 인덱스 | 5개 배포됨 |
| Cloud Functions | `verifyLocation` · `issueTicket` · `enterRaffle` — 전부 배포됨 |
| 시드 데이터 | 최애 3 · 촬영지 5 · 코스 2 · 응모 4 |
| 세션 TTL | `verificationSessions.expiresAt` — 24시간 후 자동 삭제, ACTIVE |

**앱이 붙기만 하면 되는 상태다.**

> **이 문서는 2026-08-22 시점의 인수 기록이다.** 그 뒤의 변경은 앱 레포의
> [`backend-contract.md`](https://github.com/spencer0124/pindom/blob/main/docs/reference/backend-contract.md)
> 가 기준이며, 두 저장소의 소통도 그 문서에서 한다. 이 문서에서 그 뒤에 달라진 것은
> **`verifyLocation` 의 판정 순서**(아래 표, 2026-08-26 수정)와 **촬영지 데이터의 출처**
> (손으로 넣던 값이 TourAPI 적재로 바뀌었고 좌표도 함께 움직였다 —
> [tourapi-usage](tourapi-usage.md))다. 둘 다 아직 배포 전이다.

## 접속 정보

| 항목 | 값 |
| --- | --- |
| 프로젝트 | `pindom-1234` |
| Firestore 위치 | `asia-northeast3` (서울) — 변경 불가 |
| Functions 리전 | `asia-northeast3` |

```ts
getFunctions(app, 'asia-northeast3')   // 빼먹으면 us-central1 로 붙어 not-found
```

함수는 2세대이고 `maxInstances: 10`, `minInstances: 0` 이다. **첫 호출은 콜드 스타트로 2~4초**
걸릴 수 있다. GPS인증 화면의 로딩 표현이 그 시간을 견뎌야 한다. 출시 직전에 `verifyLocation` 만
상시 인스턴스로 올릴 계획이다.

---

## 1. 함수 3개

계약서와 다른 부분만 굵게 표시했다.

### `verifyLocation`

요청·응답은 계약서 그대로다. 거부는 throw 가 아니라 `verified: false` 로 온다.

> **추가된 검사 — `capturedAt` 은 서버 시각 ±5분 안이어야 한다.**
> 벗어나면 `invalid-argument` 로 **던진다**(거부가 아니다). 시각이 속도 계산의 분모라서, 과거
> 시각을 보내면 어떤 이동도 느려 보여 속도 검사가 통째로 무력해진다. 기기 시계가 몇 분 틀어지는
> 것은 흔해서 5분을 뒀다.
>
> 앱은 측정 직후 바로 전송하면 그대로 통과한다. 촬영 후 한참 뒤에 재전송하는 흐름을 만들지 않기만
> 하면 된다.

판정 순서와 값:

| 순서 | 조건 | `reason` |
| --- | --- | --- |
| 1 | 직전 발행 티켓 대비 300km/h 초과 | `implausible_speed` |
| 2 | `isMock === true` | `mock_location` |
| 3 | `accuracy > 65` | `poor_accuracy` — 이 측정은 세션에 기록되지 않는다 |
| 4 | 반경(`places.radiusMeters`, 기본 50) 밖 | `out_of_radius` |
| 5 | 세션 내 200m 이상 이동 쌍이 150km/h 초과 | `implausible_speed` |

거리는 **기기가 보고한 오차 반경을 뺀 값**으로 판정한다. 60m 지점에서 `accuracy: 15` 면 45m 로
친다. 응답의 `distanceMeters` 도 그 값이라 화면의 표와 판정이 어긋나지 않는다.

1번은 **세션을 여는 호출에서만** 돈다. 이후 측정은 5번이 같은 일을 하고, 매번 돌리면 핑마다 문서를
둘씩 더 읽는다. 판정 강도는 같다.

**1번이 맨 앞인 이유** (2026-08-26 수정): 예전에는 이 검사가 맨 뒤에서 "세션에 기록된 측정이
없을 때" 만 돌았다. 그런데 `mock_location`·`out_of_radius` 거부도 측정으로 기록되기 때문에,
세션 첫 핑을 일부러 반경 밖으로 쏘면 이 검사가 통째로 소모되고 그 세션은 끝까지 300km/h 게이트
없이 지나갔다. 지금은 어떤 거부보다 앞에 있다. **첫 핑이 반경 밖이면서 동시에 불가능한 속도이면
`out_of_radius` 가 아니라 `implausible_speed` 가 온다.**

`grant.token` 은 `sessionId` 와 같은 값이고 **유효시간 10분**이다. 계약서에 값이 없어 앱 목
구현(`mock.ts`)이 쓰던 10분을 그대로 따랐다.

### `issueTicket`

```ts
{ grantToken, photoPath, visibility }
→ { ticketId, serial, ticketBalance, tier }
```

> **응답에 `tier` 가 있다.** 티켓 발행 화면이 등급 진행 문구를 바로 띄우도록 계약서 본문이
> 요구한 값이다.

앱이 지켜야 할 것:

- `photoPath` 는 **`tickets/{uid}/` 로 시작**해야 한다. 아니면 `invalid-argument`. 실제 객체가
  없어도 `not-found`
- 사진 업로드 → 경로 전달 순서를 지킨다. 함수가 파일을 확인한 뒤 다운로드 URL 을 만들어
  `tickets.photoUrl` 에 넣는다
- 그랜트 하나는 티켓 하나다. 재시도로 같은 `grantToken` 을 다시 보내면 `grant_consumed`

에러(`failed-precondition`, `details.errorCode`):

| 코드 | 뜻 |
| --- | --- |
| `grant_expired` | 그랜트가 만료·타인 소유·미인증 |
| `grant_consumed` | 이미 티켓이 나간 그랜트 |
| `cooldown_active` | 30일 안. `details.nextAvailableAt` (ISO 8601) 이 함께 온다 |

### `enterRaffle`

```ts
{ raffleId, idempotencyKey }
→ { entryId, ticketBalance, ticketIds, ticketsSpent }
```

> **계약서 응답 표에는 `ticketIds` 와 `ticketsSpent` 가 빠져 있다.** 앱 코드
> (`repositories/firebase.ts`)가 두 필드를 읽고 있어 함수가 넷 다 돌려준다. 계약서 정정 요청
> 목록에 넣었다.

- `idempotencyKey` 는 `^[A-Za-z0-9_-]{1,64}$`. **응모 화면이 열릴 때 한 번 만들어 모든 재시도에
  같은 값을 쓴다.** 호출마다 새로 만들면 재시도가 새 응모가 되어 티켓이 두 번 빠진다
- 차감은 **오래된 티켓부터**다. 계약서에 순서 규정이 없어 정했다
- 에러: `insufficient_tickets`(잔액 부족) · `deadline-exceeded`(마감) · `invalid-argument`(키 형식)

---

## 2. 보안 규칙 — 앱이 할 수 있는 것과 없는 것

규칙은 결과를 걸러주지 않는다. **조건이 빠진 쿼리는 결과가 비는 게 아니라 통째로
`permission-denied` 로 거부된다.** 아래를 어기면 그렇게 보인다.

| 컬렉션 | 앱이 할 수 있는 것 |
| --- | --- |
| `places` · `artists` · `courses` · `raffles` | 읽기만 |
| `places/*/gallery` | 읽기만 — `issueTicket` 이 쓴다 |
| `places/*/reviews` | 본인 이름으로 작성·수정(`text`/`tags`)·삭제 |
| `users/{uid}` | **본인 문서만** 읽기. 생성 1회, 수정은 여섯 필드 |
| `tickets` | 본인 것 읽기, `visibility` 만 수정 |
| `raffleEntries` | 본인 것 읽기만 |
| `posts` | 본인 이름으로 작성·수정(`body`/`imageUrls`)·삭제 |
| `verificationSessions` | **없음** — 읽지도 쓰지도 못한다. `sessionId` 만 되돌려주면 된다 |

지켜야 할 조건 다섯 가지:

1. **회원가입** — `users/{uid}` 를 문서 id 가 uid 인 자리에 만들고 카운터 3개를 literal `0` 으로.
   `tier` 를 넣으면 거부된다(함수 전용 필드)
2. **프로필 수정** — `nickname` · `avatarUrl` · `bio` · `followedArtistIds` ·
   `profileVisibility` · `locale` 여섯 개만. 하나라도 다른 필드가 섞이면 요청 전체가 거부
3. **티켓 목록** — 쿼리에 `where('userId', '==', uid)` 가 반드시 있어야 한다. 없으면 전체 거부
4. **글·리뷰 작성** — `authorId` 는 본인, `authorNickname` 과 `authorTier` 는 **본인 `users`
   문서의 값과 같아야** 한다. 위조를 막는 대조다. 등급이 아직 없는 신규 사용자는 `club10` 으로
   보내면 된다. `likeCount` · `commentCount` 는 `0`
5. **`createdAt` 은 반드시 `serverTimestamp()`** — 서버 시각과 대조한다. 클라이언트 시각을 넣으면
   거부된다. 미래 시각으로 피드 상단을 점유하는 것을 막는 조건이다

Storage:

- `tickets/{uid}/…` 와 `posts/{uid}/…` 만. 이미지 타입, **10MB 미만**
- 목록 조회(list)는 닫혀 있다. 파일 하나 읽기는 로그인 사용자면 된다
- EXIF 제거는 계약대로 앱 책임 — 업로드 전 재인코딩 한 번이면 같이 떨어진다

---

## 3. 계약서와 달라진 것 (정정 요청)

동작을 막는 것은 없다. 문서 표기만 맞추면 된다.

| # | 계약서 | 실제 | 이유 |
| --- | --- | --- | --- |
| 1 | `users` update 는 `nickname`·`avatarUrl` | 여섯 필드 | 두 개로 쓰면 프로필 편집·언어·최애 찾기가 전부 `permission-denied` |
| 2 | 타인 `users` 의 `nickname`·`avatarUrl`·`tier` 읽기 허용 | **타인 문서 읽기 없음** | 규칙은 필드 단위 읽기를 막을 수 없어 문서를 열면 `email` 까지 나간다. 타인 프로필 화면이 설계에 없고, 피드·리뷰는 작성자 정보를 이미 비정규화해 들고 있다. 화면이 생기면 공개 3필드만 `userProfiles/{uid}` 로 분리해 연다 |
| 3 | 리뷰는 "장소당 1개" | 강제하지 않음 | 앱이 자동 id 로 만들고 `ticketId` 를 보내지 않아, 규칙이 방문 여부를 확인할 방법이 없다. **가본 적 없는 장소에도 쓸 수 있다.** 되살리려면 리뷰 문서 id 를 `ticketId` 로 쓰고 필드로도 보내면 된다 — 규칙 두 줄이면 티켓당 1개까지 함께 생긴다 |
| 4 | `posts` 스키마에 `boardId`·`authorTier` 없음 | 앱이 둘 다 쓴다 | 스키마를 정본으로 보고 규칙은 받아들인다. 표에 두 필드 추가 필요 |
| 5 | `places.reviewCount` 는 Function-only | **아무도 쓰지 않는다** | 리뷰는 클라이언트가 쓰고 함수 셋 중 리뷰를 건드리는 것이 없다. 영원히 `0` 이다. 화면은 리뷰 목록 길이를 쓰고, 계약서에서는 빼자 |
| 6 | `enterRaffle` 응답은 `{ entryId, ticketBalance }` | `ticketIds`·`ticketsSpent` 도 반환 | 앱이 이미 읽고 있다 |

## 4. 백엔드가 정한 값

계약서에 비어 있던 자리다. 전부 함수 안 상수라 바꾸는 비용은 재배포 한 번이다.

| 항목 | 값 | 근거 |
| --- | --- | --- |
| 등급 | `club10` 0–19 · `club20` 20–29 · `clubGo` 30+ | 프로토타입의 `TICKETS OWNED 12` / `TIER 10—19` 에서 구간 폭 10. **발행 수 기준·전역** — 잔액 기준이면 응모할 때마다 등급이 내려간다 |
| 그랜트 유효시간 | 10분 | 앱 목 구현이 쓰던 값 |
| `capturedAt` 허용 오차 | ±5분 | 기기 시계 오차는 흔하고, 더 열면 속도 검사가 무력해진다 |
| 응모 차감 순서 | 오래된 티켓부터 | 규정이 없어 사용자에게 유리한 쪽으로 |

**등급 경계는 여전히 제품 결정이다.** 다른 값이면 알려주면 그날 바꾼다. 특히 `clubGo` 의 30은
구간 폭을 이어붙인 값이라 프로토타입에 근거가 없다.

## 5. 시드 데이터

개발 중 이 id 들을 그대로 쓰면 된다.

| 컬렉션 | id |
| --- | --- |
| `artists` | `artist-lumina` · `artist-echoline` · `artist-nightpost` |
| `places` | `place-jumunjin` · `place-gamcheon` · `place-namsan` · `place-cheonggye` · `place-eurwangni` |
| `courses` | `course-gangneung` · `course-seoul-night` |
| `raffles` | `raffle-fansign` · `raffle-album` · `raffle-concert` · `raffle-closed` |

앱 레포 `src/mocks` 에서 옮겼고, 문자열은 `{ ko, en }` 맵으로 바꿨다. **카운터는 전부 `0`** 이다 —
목 데이터의 `ticketCount: 1284` 같은 숫자를 옮기면 화면에서만 그럴듯하고 첫 발행에서 어긋난다.
en 문장은 백엔드가 옮겼다. 원문 자체가 권리 확인 전 자리표시자라, 카피가 정해지면 교체하면 된다.

GPS 인증을 실제로 시험하려면 `place-jumunjin` (37.8983, 128.8306) 반경 50m 안의 좌표를 보내면
된다.

## 6. `permission-denied` 가 뜰 때 보는 곳

| 증상 | 원인 |
| --- | --- |
| 티켓 목록이 통째로 거부 | 쿼리에 `userId == uid` 가 빠졌다 |
| 프로필 저장이 거부 | 여섯 필드 밖의 값이 섞였다. `updatedAt` 같은 필드를 얹으면 걸린다 |
| 글·리뷰 작성이 거부 | `authorNickname`/`authorTier` 가 본인 `users` 문서와 다르거나, `createdAt` 이 `serverTimestamp()` 가 아니다 |
| 회원가입 직후 문서 생성 거부 | 카운터가 `0` 이 아니거나 `tier` 가 들어갔다 |
| 사진 업로드 거부 | 경로의 uid 가 본인이 아니거나, 이미지가 아니거나, 10MB 이상 |
| 함수가 `not-found` | 리전을 안 붙였다. `getFunctions(app, 'asia-northeast3')` |

## 7. 남은 위험

- **App Check 없음** — 합의된 제외다. 고친 앱이 `isMock: false` 를 보내는 것을 막을 수 없고,
  iOS 는 mock 판별 API 자체가 없어 반경·속도 검사에 기댄다. `maxInstances: 10` 은 그 상태에서
  청구서가 폭주하지 않게 하는 방어선이다
- **리뷰 방문 검증 없음** — 위 3번
- 콜드 스타트 2~4초 — 출시 직전 조정 예정

## 관련 문서

- [`backend-contract-review.md`](backend-contract-review.md) — 판단의 근거가 전부 여기 있다
- [`README.md`](../README.md) — 명령, 배포 상태, 배포에서 막혔던 자리
