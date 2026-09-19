# 관데공 사진 핀

관데공 사진 23개를 별도 장소 문서로 추가한다. 공개 이름은 `YHJ` 4개,
`JSY` 3개, `LJW` 3개, `KMJ` 13개로 표시한다. 같은 건물에 기존 장소가
있어도 사진별 고정 ID를 쓰며 기존 장소·카운터를 덮지 않는다.

## 사진과 좌표

- 그룹: `artist-gwandegong` · 관데공
- 장소 ID: `place-gdg-{yhj|jsy|ljw|kmj}-{01..13}`
- 제공 배경 21장: 긴 변 최대 1,600px JPEG, 원본 파일은 보존
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
