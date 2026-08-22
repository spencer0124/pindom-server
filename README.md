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
| `node --test functions/test/logic.test.mjs` | 판정 로직 테스트 (에뮬레이터 불필요) |
| `firebase emulators:exec --only firestore,storage "node --test --test-force-exit functions/test/rules.test.mjs"` | 보안 규칙 테스트 |
| `firebase emulators:exec --only auth,firestore,storage,functions "node --test --test-force-exit functions/test/functions.test.mjs"` | 함수 동작 테스트 |
| `firebase deploy --only functions` | 함수만 배포 |
| `firebase deploy` | 전체 배포 |
| `npm --prefix functions run seed` | 시드 데이터 적재 (에뮬레이터). 실제 프로젝트는 `-- --project <id> --yes` |

## 결정 사항

| 항목 | 값 | 근거 |
| --- | --- | --- |
| Firestore 위치 | `asia-northeast3` (서울) | 생성 시 확정, 변경 불가 |
| Functions 리전 | `asia-northeast3` | 앱은 `getFunctions(app, 'asia-northeast3')` 로 호출 |
| 함수 개수 | 3개 (`verifyLocation`·`issueTicket`·`enterRaffle`) | 나머지는 규칙으로 처리 |
| 그랜트 유효시간 | 10분 | 계약서에 값이 없어 앱 목 구현이 쓰던 값을 따랐다 |
| 등급 구간 | `club10` 0–19 · `club20` 20–29 · `clubGo` 30+ | 발행 수 기준·전역. 프로토타입의 `TIER 10—19` 에서 구간 폭 10 |
| 응모 차감 순서 | 오래된 티켓부터 | 계약서에 순서 규정 없음 |

설계 판단의 근거는 [docs/backend-contract-review.md](docs/backend-contract-review.md) 에 있다.

## 배포 상태

`pindom-1234` 에 규칙·인덱스·함수·시드가 올라가 있다. 함수 셋 다 `asia-northeast3`, 2세대,
Node 22, callable.

배포에 한 번씩 걸렸던 것들 — 같은 자리에서 다시 막히지 않도록 적어 둔다.

| 증상 | 원인과 조치 |
| --- | --- |
| `iam.serviceaccounts.actAs denied ... -compute@developer` | 2세대 함수는 Cloud Run 위에서 돌고 실행 주체가 Compute Engine 기본 서비스 계정이다. 그 계정은 `compute.googleapis.com` 을 켜야 생긴다. 켜고 2~3분 뒤 재배포 |
| `functions:artifacts:setpolicy` 가 저장소를 못 찾음 | 기본 리전이 `us-central1` 이다. `--location asia-northeast3` 를 붙인다 |
| 시드에서 `Could not load the default credentials` | `firebase login` 은 CLI 토큰이라 Admin SDK 가 쓰지 못한다. `gcloud auth application-default login` 이 필요하다. 서비스 계정 키는 이 레포가 public 이라 쓰지 않는다 |

TTL 정책은 `firebase.json` 으로 배포되지 않아 한 번 따로 설정한다.

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

## 보안

이 저장소는 public이다. 서비스 계정 키는 절대 커밋하지 않는다 — `.gitignore` 참고.
보안 규칙과 함수 코드는 공개되어도 무방하다. 보안은 규칙 자체에서 나오는 것이지
코드를 숨기는 데서 나오지 않는다.
