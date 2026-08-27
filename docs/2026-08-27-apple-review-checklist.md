# Apple 심사 가이드라인 반영 현황 (2026-08-27)

다른 세션에서 "작업 분담" 표(공식 규정 화면·신고·차단·콘텐츠 필터링·회원탈퇴·지원 페이지)를
보고 백엔드 담당 네 건에 착수했다. 이 문서는 실제로 뭐가 코드로 들어갔고 뭐가 아직 안
됐는지 확인한 결과다.

## 백엔드 담당 (이 레포)

| 항목 | 가이드라인 | 상태 |
| --- | --- | --- |
| 신고 버튼 | 1.2 | 코드 있음. 미배포 |
| 사용자 차단 | 1.2 | 코드 있음. 미배포 |
| 콘텐츠 필터링 | 1.2 | 코드 있음. 미배포 |
| 회원 탈퇴 | 5.1.1(v) | 코드 있음. 미배포 |

네 건 모두 `git status` 기준 **커밋도 배포도 안 된 상태**다. `npm run build`,
`node --test functions/test/logic.test.mjs` 는 통과 확인했다 — 코드 자체는 동작한다.
커밋·배포는 다른 세션이 계속 작업 중일 수 있어 이 문서 작성 시점엔 건드리지 않았다.

### 신고 버튼 — `reports` 컬렉션

`firestore.rules` 에 `reports/{reportId}` 추가. 넣기만 하는 상자다.

- `create`: 로그인 사용자, 필드는 `reporterId`·`targetType`·`targetId`·`reason`·`createdAt`
  정확히 다섯 개만 (`hasOnly`). `targetType` 은 `post`·`comment`·`review`·`photo`·`user` 중 하나.
- `read`·`update`·`delete`: 전부 `false`. 신고자 본인도 못 읽는다 — 열면 "누가 누구를
  신고했는가" 명단이 되고 신고 대상이 조회할 수 있게 된다. 처리는 Firebase 콘솔에서.
- **앱이 할 일**: 게시글·댓글·사진·리뷰 각 화면에 신고 버튼을 달고 위 다섯 필드로
  `addDoc`.

### 사용자 차단 — `users.blockedUserIds`

`users/{uid}` 의 클라이언트 편집 가능 필드에 `blockedUserIds` 추가 (배열, 최대 1000개).
값이 걸린 데이터가 아니라 본인 문서 안의 목록이라 함수를 거칠 이유가 없다.

- 규칙은 필드 형식만 본다. **실제로 피드에서 걸러 보여주는 건 앱 몫** — 규칙은 쿼리를
  심사할 뿐 결과를 걸러주지 않는다.
- **앱이 할 일**: 차단 버튼에서 `blockedUserIds` 에 상대 uid 추가/제거. 피드·댓글·게시글
  목록을 렌더링할 때 `authorId in blockedUserIds` 인 항목을 클라이언트에서 제외.

### 콘텐츠 필터링 — 금칙어 필터 (Firestore 트리거)

`functions/src/logic.ts` 에 `BANNED_WORDS`·`containsBanned()`. `functions/src/index.ts` 에
`moderatePost`(`posts/{postId}`)·`moderateReview`(`places/{placeId}/reviews/{reviewId}`)
트리거 — 금칙어가 걸리면 문서를 **삭제**한다.

- create 뿐 아니라 update 도 본다 — 깨끗한 글을 올린 뒤 고쳐 넣는 우회를 막는다.
- 숨김 처리 대신 삭제인 이유: 숨김 필드를 두면 피드·갤러리 쿼리와 색인을 전부 고쳐야
  하는데, 걸리는 글이 드문 데 비해 비용이 크다.
- `containsBanned` 단위 테스트 통과 확인 (평범한 글 통과 / 금칙어 탐지 / 공백·구두점 회피
  탐지).
- **앱이 할 일**: 없음. 다만 실효성은 서버 목록에 있으므로(이미지의 지적대로) 클라이언트
  쪽에 추가로 입력 단계에서 막는 필터를 넣어도 되지만 필수는 아니다 — 서버 트리거가
  최종 방어선이다.

### 회원 탈퇴 — `deleteAccount`

콜러블 함수. Firestore 문서(티켓·갤러리·게시글·리뷰·응모·인증세션·신고·`savedPlaces` 포함
하위 컬렉션 전체) 삭제 → Storage 원본(`tickets/{uid}/`, `posts/{uid}/`) 삭제 → 마지막에
Auth 계정 삭제. Auth 를 맨 마지막에 지우는 이유: 중간에 실패해도 사용자가 남아 있어 다시
부를 수 있다 — 먼저 지우면 남은 데이터를 지울 주체가 사라진다.

- `ponytail:` 페이지네이션 없음 — 컬렉션당 한 번씩만 읽는다. 한 사람 몫이라 수천 건이
  될 일이 없다는 전제. 넘치기 시작하면 커서 페이지네이션으로 바꾼다.
- **앱이 할 일**: 설정 화면에 "계정 삭제" 버튼 → `deleteAccount` 호출 → 성공하면 로그아웃
  처리.

## 앱 담당 — 이 레포에서 확인 불가

| 항목 | 가이드라인 | 비고 |
| --- | --- | --- |
| 공식 규정 화면 + Apple 비후원 문구 | 5.3.2 | 앱 레포(`pindom`) 소관. 여기서 확인 못 함 |
| 지원 페이지 문구 수정 | 5.1.1(v) | 앱 레포 소관. 여기서 확인 못 함 |

## 남은 일

1. 위 네 건 커밋 — 다른 세션 작업 중이면 그쪽이 마무리하는 대로.
2. `firebase deploy --only functions,firestore:rules` — 커밋 후 배포해야 실제로 반영된다.
   지금은 코드만 있고 라이브에는 없다.
3. `blockedUserIds` 필터링·신고 버튼·회원탈퇴 버튼은 앱 쪽 작업 — `backend-contract-review.md`
   에 정식 요청 항목으로 옮길지 확인 필요.
