# 병목 점검과 처리 (2026-08-28)

보안·기능 양면에서 "무엇이 먼저 무너지는가" 를 찾고 여덟 건을 처리한 기록.

점검 시점 프로덕션 실측: places 5, tickets 1, users 3, auth 4(admin 1), posts 2, reports 0
— **런칭 전 빈 상태**다. 아래는 지금 터지는 문제가 아니라 규모가 붙는 순간 먼저 무너지는
순서다.

## 처리 결과

| # | 항목 | 상태 |
| --- | --- | --- |
| 1 | `radiusMeters` 상한 | 코드 완료 |
| 2 | 래플 `entryCount` 를 트랜잭션 밖으로 | 코드 완료 |
| 3 | 이메일 인증 게이트 | 코드 완료, **플래그 off** |
| 4 | 한도 카운터를 `rateLimits/{uid}` 로 분리 | 코드 완료 |
| 5 | 금칙어 필터를 격리로 전환 | 코드 완료 |
| 6 | admin 계정 2단계 인증 | **콘솔 작업 — 미처리** |
| 7 | App Check | **앱 레포 선행 — 미처리** |
| 8 | 데모 전 `minInstances` | **의도적 미적용** |

---

## 1. `radiusMeters` 상한 (`MAX_RADIUS_M = 500`)

`normalizePlace` 의 반경 검사에 상한이 없었다. `savePlace({ radiusMeters: 1e9 })` 면 지구
전체가 그 촬영지의 인증 반경이 된다.

티켓은 응모에 쓰이는 화폐이고 위치 인증이 그 화폐의 유일한 발행 조건이다. 즉 이 값이
사실상 발행량을 정하는 손잡이인데 잠겨 있지 않았다. 악의가 없어도 터진다 — `50` 을
`50000` 으로 오타 내면 강릉시 전체가 인증 구역이 되고 아무도 모르는 채 티켓이 샌다.

기존 촬영지 5곳은 전부 50m 라 상한 적용에 영향 없음(배포 전 확인).

## 2. 래플 `entryCount` — 응모 스탬피드에서 유일하게 즉사하는 지점

`enterRaffle` 트랜잭션이 `raffles/{raffleId}.entryCount` 를 올리고 있었다. 래플은 본질적으로
스탬피드다 — "응모 시작" 이 뜨면 전원이 동시에 누른다. 그런데 그 문서는 응모자 전원이
공유하는 하나뿐이고, Firestore 는 문서당 지속 쓰기가 초당 1회 남짓이다.

결과: 동시 응모자들이 같은 문서를 놓고 경합 → 트랜잭션이 `ABORTED` 로 죽고, 죽을 때마다
읽기 네 번(티켓 쿼리 포함)이 통째로 재실행 → 사용자에게는 "응모 실패". 티켓은 멀쩡한데
응모만 안 되는 상태다.

`countRaffleEntry` 트리거(`onDocumentCreated('raffleEntries/{entryId}')`)로 옮겼다.
**응모는 반드시 성공해야 하고 숫자는 좀 늦어도 된다**는 순서로 바꾼 것이다.

남은 한계(코드에 `ponytail:` 로 표시): 트리거도 같은 문서에 쓰므로 초당 1회 한계 자체는
그대로고, at-least-once 라 드물게 한두 개 더 셀 수 있다. 정확한 수가 필요해지면(당첨자
추첨 등) 이 값을 믿지 말고 `raffleEntries.where('raffleId','==',id).count()` 집계 쿼리로 센다.

같은 성질의 핫 도큐먼트가 `places/{id}` 에도 있다(`verifyCount`·`ticketCount`·`photoCount`).
트랜잭션 밖이라 덜 급해서 이번엔 두었다 — 촬영지 한 곳에 초당 1명 넘게 인증이 몰리기
시작하면 같은 처방(트리거 또는 집계 쿼리)이 필요하다.

## 3. 이메일 인증 게이트 — `REQUIRE_EMAIL_VERIFIED` (기본 false)

이 백엔드의 비용 방어는 전부 uid 당으로 걸려 있다:

| 방어 | 한도 | 우회 비용 |
| --- | --- | --- |
| `askAssistant` | 100회/일 | 계정 하나 더 |
| `verifyLocation` | 200회/일 | 계정 하나 더 |
| 쿨다운 | 장소당 30일 | 계정 하나 더 |

그런데 Identity Toolkit 실조회 결과 이메일·비밀번호 가입이 열려 있고(`signIn.email.enabled:
true`), 가입 쿼터가 없고(`quota: {}`), 코드 어디에도 `emailVerified` 검사가 없었다. **uid 가
사실상 공짜**라 개별 한도를 아무리 조여도 그 위가 안 막힌다.

`requireVerifiedUid()` 를 만들어 돈 걸린 호출 다섯 개에 붙였다 — `verifyLocation`,
`issueTicket`, `enterRaffle`, `askAssistant`, `getRoute`. `deleteAccount` 는 제외했다:
탈퇴는 항상 가능해야 한다(Apple 5.1.1(v)).

**기본은 꺼져 있다.** 앱이 가입 직후 `sendEmailVerification()` 을 보내기 전에 켜면 신규
가입자가 전부 막힌다 — 서버만 먼저 켤 수 있는 종류의 방어가 아니다.

켜는 절차:
1. 앱이 가입 플로우에 `sendEmailVerification()` + 미인증 안내 화면을 붙인다.
2. 기존 계정 정리 — 현재 테스트 계정 3개가 전부 `emailVerified: false` 다.
3. `functions/.env` 의 `REQUIRE_EMAIL_VERIFIED=true` 로 바꾸고 배포.

`functions/.env` 는 이번에 `.gitignore` 에서 되살렸다(`!functions/.env`). 파라미터는 비밀이
아니고 — 비밀은 Secret Manager 에 있다 — 배포 시점 값이 코드 리뷰에 보여야 해서다.

## 4. 한도 카운터를 `rateLimits/{uid}` 로 분리

어제 넣은 일일 상한 카운터가 `users/{uid}` 안에 있었다. 두 가지가 걸렸다:

**경합.** `verifyLocation` 은 GPS 체크인 한 번에 여러 번 불린다(`MAX_READINGS = 5`). 카운터가
users 문서에 있으면 그 연타가 `issueTicket` 의 `ticketBalance`·`tier` 쓰기와 같은 문서를
놓고 다툰다. 문서당 초당 1회 한계에 사용자 본인이 혼자 부딪힌다 — 체크인이 느려진다.
어제 8번을 고치면서 내가 만든 회귀다.

**규칙.** users 는 클라이언트가 만드는 문서다. 서버 전용 필드를 거기 두면 가입 요청에
`assistantCallCount: -1000000` 을 끼워 넣는 우회를 규칙에서 필드마다 막아야 하고, 새 카운터가
생길 때마다 그 목록을 잊지 않고 늘려야 한다. 닿을 수 없는 곳에 두는 편이 잊어버릴 수 있는
방어보다 낫다.

`consumeDailyQuota(uid, field, limit, ...)` 헬퍼 하나로 합치고 `rateLimits/{uid}` 로 옮겼다.
규칙에서 이 컬렉션은 전면 차단(`read, write: if false`) — 읽히면 남은 횟수가 새고, 쓰이면
상한이 무의미해진다. 그 덕에 `users` create 의 필드 가드 네 줄은 지웠다.

`deleteAccount` 도 `rateLimits/{uid}` 를 같이 지운다.

기존 사용자 3명의 문서에 `assistantCallDay`·`verifyCallCount` 등이 남아 있지만 이제 아무도
읽지 않는 죽은 필드다. 런칭 전이라 정리하지 않았다.

## 5. 금칙어 필터 — 삭제에서 격리로

`moderatePost`·`moderateReview` 가 걸린 글을 그냥 지우고 있었다. `containsBanned` 는
공백·구두점을 지운 뒤 부분 문자열로 보는 방식이라 낱말 경계를 넘는 오검출이 원리상 남는데,
걸린 사용자에게는 글이 소리 없이 사라진 것으로만 보이고 **문의가 와도 뭘 썼는지조차 확인할
수 없었다.**

지우기 전에 원문을 `moderationQueue` 에 통째로 옮기도록 바꿨다(`sourcePath`, `matchedWord`,
`authorId`, `document`, `quarantinedAt`). 피드 쿼리·색인은 그대로다 — 문서는 여전히
사라지고, 복구 경로만 생겼다. 규칙에서 이 컬렉션도 전면 차단이다: 열면 걸러낸 욕설을 그대로
읽는 창구가 된다.

`BANNED_WORDS` 에서 `존나` 를 뺐다. 아이돌 팬 커뮤니티에서 일상적인 강조어라 잡는 족족
멀쩡한 글이 격리된다 — 목록의 목적은 욕설 차단이지 말투 교정이 아니다.

## 6. admin 계정 2단계 인증 — 콘솔 작업, 미처리

admin 클레임을 가진 계정은 현재 1개(`google.com` 제공자)다. 이 계정 하나가 `savePlace` 로
촬영지 좌표·반경을 정할 수 있고, 그게 곧 티켓 발행 조건이다. **admin Google 계정 = 화폐
발행기**다. 그런데 프로젝트 MFA 는 `state: DISABLED` 다.

1번에서 반경 상한을 걸어 피해 범위는 줄었지만 계정 자체의 방어는 서버 코드로 못 한다.
해당 Google 계정에서 2단계 인증을 직접 켜야 한다 — **이건 코드가 아니라 사람이 할 일이다.**

관리자 쓰기 감사 로그도 없다. 이번엔 넣지 않았다(요청 범위 밖). 필요해지면 `saveBoard`·
`saveArtist`·`savePlace`·`delete*` 에 `adminLog` 컬렉션 쓰기를 붙이면 된다.

## 7. App Check — 앱 레포 선행, 미처리

`enforceAppCheck` 가 코드에 없고, 에뮬레이터 로그가 매 호출 `{"app":"MISSING"}` 을 찍는다.
함수 URL 은 공개고 ID 토큰만 있으면 누구나 `curl` 로 때린다.

3번(이메일 인증)은 계정 양산 비용을 올리는 임시책일 뿐이고, **근본 대책은 이것 하나다** —
정품 앱에서 온 호출만 통과시키면 계정을 몇 개 만들든 이득이 없어진다.

서버만으로는 못 켠다. 앱에 App Check SDK(iOS 는 App Attest, Android 는 Play Integrity)를
붙이는 작업이 선행돼야 하고, 그 전에 켜면 모든 호출이 막힌다. 순서:

1. 앱: App Check SDK 초기화 + Firebase 콘솔에서 앱 등록.
2. 콘솔에서 "모니터링" 모드로 며칠 관찰 — 정품 호출 비율 확인.
3. 서버: `setGlobalOptions({ ..., enforceAppCheck: true })` 로 바꾸고 배포.

**앱 레포와 묶어야 하는 항목.** 백엔드 단독으로는 여기까지가 끝이다.

## 8. `minInstances` — 의도적 미적용

콜드 스타트 대비책을 안 둔 건 원래 의도다(상시 과금). `verifyLocation` 은 "버튼 눌렀는데 몇
초 멈춤" 이 그대로 UX 인 함수라 데모에서 제일 먼저 체감된다.

**공모전 데모 직전에만** `verifyLocation` 에 `minInstances: 1` 을 붙이고, 끝나면 뗀다.
코드 주석에 이미 적혀 있다(`index.ts` 의 `verifyLocation` 상단). 상시 켜면 그만큼 계속
청구되므로 이번 배포에는 넣지 않았다.

---

## 병목 아님 (확인함)

- **`maxInstances: 10`** — I/O 대기 작업이라 2세대 기본 동시성(인스턴스당 80)이면 ~800 동시
  호출까지 받는다. 여기는 막히는 지점이 아니다.
- **익명 로그인** — 꺼져 있다(`signIn.anonymous: {}`). 켜져 있었다면 3번이 훨씬 급했다.
- **`askAssistant` 지연** — 도구 루프 최대 3라운드 × (OpenAI + 카카오) 순차라 체감 5~20초.
  기능은 정상이고(카카오·OpenAI 실호출로 확인) 스트리밍 없이는 개선 여지가 제한적이다.
  앱 쪽에 "찾아보는 중…" 진행 표시가 필요하다 — **앱 레포 항목.**

## 테스트

- `logic.test.mjs` 32/32 (반경 상한, `존나` 통과 케이스 추가)
- `rules.test.mjs` 34/34 (`rateLimits` 차단 추가)
- `functions.test.mjs` 22/22 (금칙어 격리 통합 테스트 추가)
