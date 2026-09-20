# 관데공 사진 핀

관데공 사진 23개를 별도 장소 문서로 추가한다. 공개 이름은 `YHJ` 4개,
`JSY` 3개, `LJW` 3개, `KMJ` 13개로 표시한다. 같은 건물에 기존 장소가
있어도 사진별 고정 ID를 쓰며 기존 장소·카운터를 덮지 않는다.

## 최초 등록 사진과 좌표

- 그룹: `artist-gwandegong` · 관데공
- 장소 ID: `place-gdg-{yhj|jsy|ljw|kmj}-{01..13}`
- 최초 제공 배경 21장: 긴 변 최대 1,600px JPEG, 원본 파일은 보존
- 제공 누끼 23장: 긴 변 최대 1,800px PNG, 투명도 보존
- 파일 메타데이터 제거, 내용 SHA-256을 Storage 경로에 사용
- 몰리또 대학로점: 배경 미제공, `coverImageUrl`은 빈 문자열
- 아르떼뮤지엄 부산: 한국관광공사 TourAPI의 외관 대표사진 URL 사용. 촬영 당시
  원본 배경으로 표시하지 않는다. API 원문 사진 메타데이터와 공공누리 제1유형
  출처를 manifest에 보존하고 앱에서 출처를 표시한다.
- 명수당·국립세종도서관: 사용자 요청에 따라 합성 참고 자료도 포함

좌표는 사용자에게 승인받은 Kakao Local API 대표 POI이다. 원래 사진을 찍은 정확한
지점이 아니며, 섬·해안·캠퍼스처럼 넓은 장소는 실제 촬영 위치와 차이가 날 수 있다.
기존 기본 인증 반경 50m를 유지한다. 방문 인증은 **핀 중심 50m** 기준이므로 실제
촬영 지점을 확인한 뒤 필요하면 좌표를 별도로 정정한다.

## 앱 계약

기존 장소 필드에 다음 선택 필드가 추가된다.

| 필드 | 의미 |
| --- | --- |
| `cutoutImageUrl` | 투명 PNG 누끼 URL |
| `cutoutAspectRatio` | 누끼 너비 / 높이 |
| `contributorInitials` | 제공자 영문 이니셜 |
| `coverImageCredit` | 외부 대표사진 출처 표시 |
| `coverImageSourceUrl` | 외부 사진 원출처 |
| `sourceMetadata` | 대표 좌표 출처, 원본/외부/누락 배경 구분, 합성 여부 |

## 추가 전용 적재

개인 이름·원본 경로를 담은 inventory는 로컬 임시 파일로만 둔다. 원본·변환 이미지는
Git에 넣지 않는다. 익명 파일명과 체크섬을 담은 manifest만 추적한다.

```sh
python3 functions/scripts/prepare-gwandegong-assets.py \
  /tmp/pindom-gwandegong-inventory.json /tmp/pindom-gwandegong-assets

node functions/scripts/import-gwandegong.mjs \
  --assets-dir /tmp/pindom-gwandegong-assets

node --test functions/test/import-gwandegong.test.mjs
```

기본 실행은 로컬 검증만 한다. 원격 적재는 다음처럼 프로젝트와 버킷을 명시한다.

```sh
node functions/scripts/import-gwandegong.mjs \
  --assets-dir /tmp/pindom-gwandegong-assets --apply \
  --project pindom-1234 --bucket pindom-1234.firebasestorage.app \
  --catalog-out /tmp/pindom-gwandegong-app-catalog.json
```

Admin SDK와 ADC를 사용한다. 이미 같은 import와 내용 해시로 등록된 문서는 그대로
둔다. 다른 문서가 같은 ID를 차지하거나 내용이 달라지면 중단한다. 이미지 업로드는
존재하지 않는 콘텐츠 경로에만 생성한다. 장소·그룹 생성은 하나의 Firestore
트랜잭션에서 수행하며, 발행 이력·카운터는 보존한다. 재실행은 중단된 업로드를
이어서 완료할 수 있다. 사용자 게시물·티켓·Storage 규칙은 변경하지 않는다.

23개 사진 핀·대표사진·좌표는 운영 데이터이므로 앱 재빌드나 Functions 배포 없이
새로 읽으면 반영된다. 누끼 촬영과 사진 출처 표시는 새 앱 코드가 필요하므로 기존
설치 앱에는 해당 코드를 포함한 앱 업데이트가 필요하다.

## 등록 검증

운영 프로젝트에서 추가한 장소 23개와 그룹의 `placeCount: 23`을 재조회했다.
Storage 44개 객체의 SHA-256 메타데이터·크기·형식이 manifest와 일치하며, 누끼와
배경 URL 45개가 이미지 응답을 반환했다. TourAPI 사진 서버는 HEAD를 지원하지 않아
GET 범위 요청의 JPEG 헤더로 확인했다. 기존 장소 8개와 사용자 문서는 변경하지 않았다.

2026-09-20 제공자 표기를 `YHJ`, `JSY`, `LJW`, `KMJ` 영문 이니셜로 변경했다.
운영 장소 23개의 `contributorInitials`, 한·영 `description`, `importContentHash`만
트랜잭션으로 갱신하고 전부 재조회했다. 사진·좌표·카운터는 유지했다.

## 카메라 테스트와 기존 테스트 장소 정리

최초 해제 시점인 2026-09-20에 관데공 23곳은 `cameraTestEnabled: true`로 위치 제한을 해제한다.
사용자 요청에 따라 종료 시간과 자동 복구는 두지 않는다. 인증 반경 50m 설정은
보존하며, 아래 해제 명령으로 테스트 모드를 끄면 다시 적용된다.

기존 테스트 장소 8곳(`place-jumunjin`, `place-gamcheon`, `place-namsan`,
`place-cheonggye`, `place-eurwangni`, `place-hyehwa`, `place-hyehwa-skk`,
`place-test-anywhere`)과 코스 2개(`course-gangneung`, `course-seoul-night`)는
`archived: true`로 보관한다. 새 앱의 지도·검색·추천에서 제외하고 새 촬영을
차단한다. 기존 티켓·게시물·리뷰·사진과 카운터는 삭제하지 않는다.

```sh
# 먼저 변경 예정 항목 확인. --apply를 붙여야 실제 변경한다.
node functions/scripts/configure-camera-testing.mjs \
  --project pindom-1234 --archive-test-places --enable-camera

node functions/scripts/configure-camera-testing.mjs \
  --project pindom-1234 --archive-test-places --enable-camera --apply

# 나중에 위치 제한을 복구할 때 실행. 보관한 장소는 그대로 둔다.
node functions/scripts/configure-camera-testing.mjs \
  --project pindom-1234 --disable-camera --apply
```

앱은 `verifyLocation({placeId, cameraTest: true})`를 GPS 좌표 없이 호출하고,
서버는 장소 설정을 확인해 `grant.testMode: true`인 권한을 발급한다. 기존 앱의
GPS 요청도 해당 설정이 켜진 장소에서는 거리·정확도 제한 없이 처리한다.
로그인, 호출 한도, 권한 소유자·10분 유효 기간·일회성 사용, 발행 주기는 유지한다.
권한 10분 만료는 촬영 권한의 수명이며, 장소 테스트 설정의 자동 복구가 아니다.
테스트 티켓은 `testMode: true`를 저장하고 새 앱의 사진·티켓에 `TEST`를 표시한다.
설정을 끄거나 장소를 보관하면 이미 받은 테스트 권한으로도 티켓을 발행할 수 없다.

Functions의 `verifyLocation`, `issueTicket`, `getPublicProfile`, `getRoute`, `askAssistant`를 배포한 뒤
운영 설정을 적용한다. 서버의 거리 제한 해제는 앱 재빌드 없이 반영된다. GPS 권한
없이 카메라에 들어가기, 보관 장소 숨기기, TEST 표시는 새 앱 코드가 필요하다.
개발 앱은 Metro 새로고침으로 확인할 수 있고 배포 앱은 업데이트 빌드·설치가 필요하다.

최초 해제 적용 후 활성 장소 23곳 모두 테스트 설정이 켜져 있고, 기존 장소 8곳과 코스
2개가 보관된 것을 재조회했다. 적용 전후 장소의 사진·좌표·카운터 등 나머지 필드가
모두 같으며, 기존 장소에 연결된 티켓 64장도 유지된다. Functions 통합 검사
165개가 통과했다. 자동 복구 작업은 등록하지 않았다.


## 원본사진 교체와 마로니에 위치 인증 복구

2026-09-21 사용자 제공 원본사진을 제공자·파일 번호로 기존 장소에 대응시켰다.
`update-gwandegong-originals.mjs`는 이미지 원본을 새 Storage 경로에 올리고
`coverImageUrl`과 관련 출처·안내만 갱신한다. 인물 누끼, 좌표, 카운터와 기존 티켓은 유지한다.
마로니에공원(`place-gdg-ljw-03`)만 `cameraTestEnabled: false`로 복구하며
기존 50m 인증 반경을 적용한다. 다른 활성 장소는 카메라 테스트를 계속 허용한다.
기본사진은 상세와 같은 필드를 사용하는 목록 썸네일에도 반영된다.

```sh
node functions/scripts/update-gwandegong-originals.mjs \
  --project pindom-1234 --originals-dir /path/to/originals
# 검토 후 --apply --report /tmp/originals-result.json 추가
```

원본사진과 적용 전 백업은 Git에 넣지 않는다. 스크립트는 전체 파일 번호·서명과
운영 import 소유권을 확인하고 문서 버전 조건을 걸어 일괄 갱신한다.
운영 데이터 변경이므로 앱 재빌드 없이 장소를 다시 불러오면 적용된다.
위의 전체 장소 `--enable-camera` 명령은 마로니에도 다시 열므로 현재 설정 유지 시 실행하지 않는다.


### 기본사진 다운로드 지연 보완

제공 원본을 그대로 전송하면 수 MB 다운로드 동안 이전 앱은 흰 영역만 표시한다.
`prepare-original-covers.swift`로 방향을 반영한 긴 변 1,200px JPEG 표시용 사본을
생성한 뒤 위 갱신 스크립트에 그 폴더를 전달한다. 원본과 인물 누끼는 수정하지 않는다.
삼길포항 원본은 전체 다운로드·체크섬 검증을 통과했고 Mac 앱에서도 지연 후 표시됐다.
표시용 사본으로 다운로드 용량을 줄이며, 앱 로딩·실패 재시도 표시는 별도 새 빌드에 포함한다.
