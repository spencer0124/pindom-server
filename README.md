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
| `firebase emulators:exec --only firestore,storage "node --test functions/test/rules.test.mjs"` | 보안 규칙 테스트 |
| `firebase deploy --only functions` | 함수만 배포 |
| `firebase deploy` | 전체 배포 |

## 결정 사항

| 항목 | 값 | 근거 |
| --- | --- | --- |
| Firestore 위치 | `asia-northeast3` (서울) | 생성 시 확정, 변경 불가 |
| Functions 리전 | `asia-northeast3` | 앱은 `getFunctions(app, 'asia-northeast3')` 로 호출 |
| 함수 개수 | 3개 (`verifyLocation`·`issueTicket`·`enterRaffle`) | 나머지는 규칙으로 처리 |

설계 판단의 근거는 [docs/backend-contract-review.md](docs/backend-contract-review.md) 에 있다.

## 배포 후 한 번 하는 설정

`verificationSessions` 의 TTL 정책은 `firebase.json` 으로 배포되지 않는다. 만료된 세션이
영구히 남지 않도록 배포 후 한 번 설정한다.

```bash
gcloud firestore fields ttls update expiresAt \
  --collection-group=verificationSessions --enable-ttl
```

## 진행 상황

- [x] Phase 0 — Firebase 프로젝트 생성, 앱 등록, Auth 활성화
- [x] Phase 1 — 계약서 리뷰
- [x] Phase 2 — 저장소 스캐폴드
- [x] Phase 3 — 보안 규칙
- [ ] Phase 4 — Cloud Functions
- [ ] Phase 5 — 시드 데이터와 배포

## 보안

이 저장소는 public이다. 서비스 계정 키는 절대 커밋하지 않는다 — `.gitignore` 참고.
보안 규칙과 함수 코드는 공개되어도 무방하다. 보안은 규칙 자체에서 나오는 것이지
코드를 숨기는 데서 나오지 않는다.
