# Apple 심사 가이드라인 반영 현황 (2026-08-27)

"작업 분담" 표(공식 규정 화면·신고·차단·콘텐츠 필터링·회원탈퇴·지원 페이지)의 백엔드 담당
네 건 — 코드·테스트·배포까지 전부 끝났다.

## 백엔드 담당 (이 레포)

| 항목 | 가이드라인 | 상태 |
| --- | --- | --- |
| 신고 버튼 | 1.2 | 완료. 배포됨 |
| 사용자 차단 | 1.2 | 완료. 배포됨 |
| 콘텐츠 필터링 | 1.2 | 완료. 배포됨 |
| 회원 탈퇴 | 5.1.1(v) | 완료. 배포됨 |

`npm run build`, `logic.test.mjs`(30), `rules.test.mjs`(33), `functions.test.mjs`(20) 전부
통과. `firebase deploy --only functions,firestore:rules,firestore:indexes` 로 배포 완료.

### 신고 버튼 — `reports` 컬렉션

`firestore.rules` 에 `reports/{reportId}` 추가. 넣기만 하는 상자다.

- `create`: 로그인 사용자, 필드는 `reporterId`·`targetType`·`targetId`·`reason`·`createdAt`
  정확히 다섯 개만 (`hasOnly`). `targetType` 은 `post`·`comment`·`review`·`photo`·`user` 중 하나.
  `targetId` 128자, `reason` 500자 상한.
- `read`·`update`·`delete`: 전부 `false`. 신고자 본인도 못 읽는다 — 열면 "누가 누구를
  신고했는가" 명단이 되고 신고 대상이 조회할 수 있게 된다. 처리는 Firebase 콘솔에서.
- **탈퇴와의 접점**: `deleteAccount` 는 본인이 넣은 신고를 지우지 않는다 — `reporterId`
  만 `'deleted'` 로 익명화한다. 그대로 지우면 다른 사용자에 대한 모더레이션 근거가 계정
  삭제 한 번에 같이 사라진다.
- **앱이 할 일**: 게시글·댓글·사진·리뷰 각 화면에 신고 버튼을 달고 위 다섯 필드로
  `addDoc`.

### 사용자 차단 — `users.blockedUserIds`

`users/{uid}` 의 클라이언트 편집 가능 필드에 `blockedUserIds` 추가 (배열, 최대 1000개).
값이 걸린 데이터가 아니라 본인 문서 안의 목록이라 함수를 거칠 이유가 없다.

- 규칙은 필드 형식만 본다. **실제로 피드에서 걸러 보여주는 건 앱 몫** — 규칙은 쿼리를
  심사할 뿐 결과를 걸러주지 않는다. Apple 답변에 "서버가 막는다" 로 쓰면 안 된다.
- **앱이 할 일**: 차단 버튼에서 `blockedUserIds` 에 상대 uid 추가/제거. 피드·댓글·게시글
  목록을 렌더링할 때 `authorId in blockedUserIds` 인 항목을 클라이언트에서 제외.

### 콘텐츠 필터링 — 금칙어 필터 (Firestore 트리거)

`functions/src/logic.ts` 에 `BANNED_WORDS`·`containsBanned()`. `functions/src/index.ts` 에
`moderatePost`(`posts/{postId}`)·`moderateReview`(`places/{placeId}/reviews/{reviewId}`)
트리거 — 금칙어가 걸리면 문서를 **삭제**한다.

- create 뿐 아니라 update 도 본다 — 깨끗한 글을 올린 뒤 고쳐 넣는 우회를 막는다.
- 숨김 처리 대신 삭제인 이유: 숨김 필드를 두면 피드·갤러리 쿼리와 색인을 전부 고쳐야
  하는데, 걸리는 글이 드문 데 비해 비용이 크다.
- `containsBanned` 단위 테스트 통과 (평범한 글 통과 / 금칙어 탐지 / 공백·구두점 회피 탐지).
- **앱이 할 일**: 없음. 서버 트리거가 최종 방어선이다. 클라이언트 쪽에 입력 단계 필터를
  추가로 넣어도 되지만 필수는 아니다.

### 회원 탈퇴 — `deleteAccount`

콜러블 함수. Firestore 문서(티켓·갤러리·게시글·리뷰·응모·인증세션·`savedPlaces` 포함
하위 컬렉션 전체) 삭제, 신고는 신원만 익명화 → Storage 원본(`tickets/{uid}/`,
`posts/{uid}/`) 삭제 → 마지막에 Auth 계정 삭제. Auth 를 맨 마지막에 지우는 이유: 중간에
실패해도 사용자가 남아 있어 다시 부를 수 있다 — 먼저 지우면 남은 데이터를 지울 주체가
사라진다.

- 통합 테스트(`functions.test.mjs`)로 확인: 본인 문서·티켓·리뷰 삭제, 신고는 남고
  `reporterId` 만 `'deleted'`, 같은 이메일로 재가입 가능(= Auth 계정 실제 삭제) 까지
  전부 실제 에뮬레이터로 검증.
- `ponytail:` 페이지네이션 없음 — 컬렉션당 한 번씩만 읽는다. 한 사람 몫이라 수천 건이
  될 일이 없다는 전제. 넘치기 시작하면 커서 페이지네이션으로 바꾼다.
- **앱이 할 일**: 설정 화면에 "계정 삭제" 버튼(확인 다이얼로그 포함) → `deleteAccount`
  호출 → 성공하면 로그아웃 처리.

## 곁다리로 같이 고친 것

Apple 항목 작업 중 같은 파일에서 발견한 보안 결함도 이번에 같이 닫았다 — 별도 감사에서
나온 것들이라 Apple 심사와 직접 관련은 없지만, 신고·차단·탈퇴 기능이 기대는 같은 규칙·
같은 함수라 놔두면 방금 넣은 방어선의 신뢰도가 떨어진다:

- `users` 문서 생성 시 `assistantCallDay`·`assistantCallCount`·`verifyCallDay`·
  `verifyCallCount` 를 끼워 넣어 AI 호출·인증 시도 상한을 무력화하는 경로를 막음.
- `verifyLocation` 의 도착(순간이동) 검사가 앞선 accuracy/radius 거부에 "체크됨" 도장만
  찍고 실제로는 안 도는 결함을 고침.
- `issueTicket` 의 쿨다운·첫방문 판정을 트랜잭션 안으로 옮겨 동시 호출로 티켓이 두 장
  나오는 경쟁 조건을 막음.
- `askAssistant`·`verifyLocation` 의 일일 호출 상한을 트랜잭션으로 묶어 동시 요청으로
  상한이 무력화되는 것을 막음.
- `posts`·`reviews`·`users.nickname/bio`·`savedPlaces.name`·`reports` 에 길이·개수 상한을
  추가(문서 비대화 방지).
- 티켓을 비공개로 되돌려도 예전 공개 URL 로 계속 사진을 볼 수 있던 것을 고침(다운로드
  토큰 회전).
- `getRoute` 의 `placeIds` 에 상한(30개)을 둬 호출 한 번으로 무제한 Firestore 읽기가
  나가는 것을 막음.

## 앱 담당 — 이 레포에서 확인 불가

| 항목 | 가이드라인 | 비고 |
| --- | --- | --- |
| 공식 규정 화면 + Apple 비후원 문구 | 5.3.2 | 앱 레포(`pindom`) 소관. 여기서 확인 못 함 |
| 지원 페이지 문구 수정 | 5.1.1(v) | 앱 레포 소관. 여기서 확인 못 함 |
| 신고·차단·탈퇴 버튼 UI | 1.2 / 5.1.1(v) | 백엔드는 준비됐고, 화면은 앱 레포 몫 |

## 남은 일

1. 앱 쪽: 신고 버튼, 차단 버튼(+ 피드 필터링), 탈퇴 버튼 붙이기.
2. `backend-contract-review.md` 에 `reports`·`users.blockedUserIds`·`deleteAccount` 를
   정식 계약 항목으로 옮길지 확인.
