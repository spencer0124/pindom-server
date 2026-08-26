# pindom-server

PINDOM의 Firebase 백엔드. Firestore 스키마, 보안 규칙, Cloud Functions, 시드 데이터를 소유한다.

앱 저장소는 [spencer0124/pindom](https://github.com/spencer0124/pindom) 이며, 두 저장소는
[backend-contract.md](https://github.com/spencer0124/pindom/blob/main/docs/reference/backend-contract.md)
를 기준으로 맞춘다. 필드 이름이 어긋나면 그 문서가 심판이다.

## 구조

| 경로 | 내용 |
| --- | --- |
| `firestore.rules` | Firestore 보안 규칙 |
| `firestore.indexes.json` | 복합 인덱스 정의 |
| `storage.rules` | Cloud Storage 보안 규칙 |
| `functions/` | Cloud Functions (TypeScript) |
| `admin/` | 관리 도구 — Hosting 에 올라가는 정적 HTML 한 장 |
| `docs/` | 계약서 리뷰 등 설계 기록 |

## 사전 준비

```bash
npm install -g firebase-tools
firebase login
npm --prefix functions install
```

에뮬레이터는 Java 를 쓴다. 없으면 `brew install openjdk` 후 PATH 에 추가한다 —
`export PATH="/opt/homebrew/opt/openjdk/bin:$PATH"`.

Cloud Functions 런타임은 Node 22다. 로컬 Node 버전이 다르면 빌드는 되지만 배포 시
런타임과 어긋날 수 있다.

## 명령

| 명령 | 하는 일 |
| --- | --- |
| `npm --prefix functions run build` | 함수 TypeScript 컴파일 |
| `firebase deploy --only firestore:rules` | Firestore 규칙만 배포 |
| `firebase deploy --only storage` | Storage 규칙만 배포 |
| `firebase deploy --only hosting` | 관리 도구만 배포 |
| `node --test functions/test/logic.test.mjs functions/test/import-tourapi.test.mjs` | 순수 로직 테스트 (에뮬레이터 불필요) |
| `firebase emulators:exec --only auth,firestore,storage,functions "node --test functions/test/*.test.mjs"` | 전체 테스트. **레포 루트에서** 돌린다 — `rules.test.mjs` 가 `firestore.rules` 를 cwd 기준으로 읽는다 |
| `npm --prefix functions run import-tourapi -- --dry-run` | TourAPI 에서 촬영지 정보를 받아 `seed-data.json` 을 채운다. 키는 `.env.local` |
| `firebase deploy --only functions` | 함수만 배포 |
| `firebase deploy` | 전체 배포 |
| `npm --prefix functions run seed` | 시드 데이터 적재 (에뮬레이터). 실제 프로젝트는 `-- --project <id> --yes` |
| `npm --prefix functions run grant-admin -- --email <메일>` | 관리자 클레임 부여. 실제 프로젝트는 `--project <id> --yes`, 회수는 `--revoke` |
| `firebase emulators:start` | 관리 도구를 로컬에서 띄운다 — <http://127.0.0.1:5055> |

## 결정 사항

| 항목 | 값 | 근거 |
| --- | --- | --- |
| Firestore 위치 | `asia-northeast3` (서울) | 생성 시 확정, 변경 불가 |
| Functions 리전 | `asia-northeast3` | 앱은 `getFunctions(app, 'asia-northeast3')` 로 호출 |
| 함수 개수 | 3개 (`verifyLocation`·`issueTicket`·`enterRaffle`) | 나머지는 규칙으로 처리 |
| 게시판 문서 id | 아이돌 게시판은 `artistId`, 자유게시판은 `free` | 계약서의 `posts.boardId` = `artistId` 를 아이돌 게시판에 한해 그대로 유지한다 |
| 게시판 삭제 | 없다. `archived` 로 내린다 | 글이 `boardId` 로 게시판을 가리킨다. 지우면 그 글들이 없는 게시판에 매달린다 |
| `maxInstances` | 10 | App Check 이 없고 함수 URL 은 공개다. 폭주가 그대로 청구서가 되는 것을 막는다 |
| 그랜트 유효시간 | 10분 | 계약서에 값이 없어 앱 목 구현이 쓰던 값을 따랐다 |
| 등급 구간 | `club10` 0–19 · `club20` 20–29 · `clubGo` 30+ | 발행 수 기준·전역. 프로토타입의 `TIER 10—19` 에서 구간 폭 10 |
| 응모 차감 순서 | 오래된 티켓부터 | 계약서에 순서 규정 없음 |

## 문서

| 문서 | 무엇 | 누가 |
| --- | --- | --- |
| [app-handoff](docs/2026-08-22-app-handoff.md) | 배포 상태, 함수 3개 사용법, 규칙이 요구하는 조건, 계약서와 달라진 부분 | **앱 개발자는 여기부터** |
| [worklog](docs/2026-08-22-worklog.md) | 계약서 리뷰 이후 작업 기록 — 판단·발견한 결함·검증 방법을 커밋 단위로 | 맥락이 필요할 때, AI 에이전트 포함 |
| [backend-contract-review](docs/backend-contract-review.md) | 계약서 리뷰 원문과 회신 | "왜 그렇게 했나" 를 볼 때 |
| [tourapi-usage](docs/tourapi-usage.md) | 관광공사 OpenAPI — 어느 서비스의 어느 오퍼레이션으로 `places` 의 어느 필드를 채우는지, 계정·쿼터·저작권 | 촬영지를 추가하거나 적재 스크립트를 고칠 때 |

필드 이름의 최종 심판은 앱 레포의 `docs/reference/backend-contract.md` 다. 그 문서와 이
저장소가 갈린 지점은 위 두 문서에 표로 정리돼 있다.

## 배포 상태

`pindom-1234` 에 규칙·인덱스·함수·시드가 올라가 있다. 함수 셋 다 `asia-northeast3`, 2세대,
Node 22, callable.

배포에 한 번씩 걸렸던 것들 — 같은 자리에서 다시 막히지 않도록 적어 둔다.

| 증상 | 원인과 조치 |
| --- | --- |
| `iam.serviceaccounts.actAs denied ... -compute@developer` | 2세대 함수는 Cloud Run 위에서 돌고 실행 주체가 Compute Engine 기본 서비스 계정이다. 그 계정은 `compute.googleapis.com` 을 켜야 생긴다. 켜고 2~3분 뒤 재배포 |
| `functions:artifacts:setpolicy` 가 저장소를 못 찾음 | 기본 리전이 `us-central1` 이다. `--location asia-northeast3` 를 붙인다 |
| 시드에서 `Could not load the default credentials` | `firebase login` 은 CLI 토큰이라 Admin SDK 가 쓰지 못한다. `gcloud auth application-default login` 이 필요하다. 서비스 계정 키는 이 레포가 public 이라 쓰지 않는다 |

TTL 정책은 처음 한 번 `gcloud` 로 켜고, 그 뒤로는 `firestore.indexes.json` 의
`fieldOverrides` 에 `"ttl": true` 로 선언해 둔다. 선언하지 않으면 인덱스 배포가 "파일에 없는
override 가 있다" 고 경고하고, `--force` 를 붙인 순간 **TTL 이 삭제된다**.

```bash
gcloud firestore fields ttls update expiresAt \
  --collection-group=verificationSessions --enable-ttl --project=pindom-1234
```

## 진행 상황

- [x] Phase 0 — Firebase 프로젝트 생성, 앱 등록, Auth 활성화
- [x] Phase 1 — 계약서 리뷰
- [x] Phase 2 — 저장소 스캐폴드
- [x] Phase 3 — 보안 규칙
- [x] Phase 4 — Cloud Functions
- [x] Phase 5 — 시드 데이터와 배포
- [x] Phase 6 — TourAPI 적재 경로 ([tourapi-usage](docs/tourapi-usage.md))

## 관리 도구

`admin/index.html` 한 장이 전부다. 프레임워크도 빌드 단계도 없고, 프로젝트 설정은 Hosting 이
내려주는 `/__/firebase/init.json` 에서 읽는다 — 그래서 페이지에 키가 박혀 있지 않고, 프로젝트를
바꿔 배포해도 고칠 것이 없다. **Hosting 을 거치지 않고 파일을 직접 열면 동작하지 않는다.**

지금 할 수 있는 것은 게시판 추가·수정이다. 촬영지 탭은 아직 없다.

처음 한 번:

1. Firebase 콘솔 · Authentication 에서 **Google 로그인을 켠다**. 페이지는 Google 팝업만 쓴다
2. `npm --prefix functions run grant-admin -- --email <메일> --project pindom-1234 --yes`
3. `firebase deploy --only hosting,functions`

클레임은 ID 토큰에 실린다. 이미 로그인해 있던 계정은 토큰이 갱신될 때까지 예전 클레임을 들고
있어서, 페이지는 로그인할 때마다 `getIdTokenResult(true)` 로 강제 갱신한다.

로컬은 `firebase emulators:start` 후 <http://127.0.0.1:5055>. (Hosting 에뮬레이터의 기본 포트
5000 은 macOS 의 AirPlay 수신 대기가 이미 쓰고 있어 비켜 뒀다.) 에뮬레이터의 Auth·Firestore·
Functions 에 자동으로 붙고, 클레임은 `FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099` 를 붙여
같은 스크립트로 준다.

## 보안

이 저장소는 public이다. 서비스 계정 키는 절대 커밋하지 않는다 — `.gitignore` 참고.
보안 규칙과 함수 코드는 공개되어도 무방하다. 보안은 규칙 자체에서 나오는 것이지
코드를 숨기는 데서 나오지 않는다.
