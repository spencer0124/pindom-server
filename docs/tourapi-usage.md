# 한국관광공사 TourAPI 활용 명세

> PINDOM 백엔드가 관광공사 OpenAPI 중 **무엇을, 어디에 속한 어느 오퍼레이션을, 어떤
> 파라미터로 불러, 어느 Firestore 필드에 넣는지** 를 정한 문서다. 코드보다 이 문서가 먼저이고,
> `functions/scripts/` 의 적재 스크립트는 이 문서의 §5 를 그대로 옮긴 것이어야 한다.

**출처.** `docs/api_docs/` 의 활용신청 매뉴얼 1개 + 서비스별 활용매뉴얼 26개 + 코드표 엑셀 3개.
버전은 국문·영문 매뉴얼 `v4.4`, 서비스 배포 버전 `4.0` 기준.
문의처는 개방데이터운영팀 `tourapi@knto.or.kr` · 070-4287-3219.

**전제.** 앱은 TourAPI 를 직접 호출하지 않는다. 백엔드만 호출해 Firestore `places` 에 적재하고
앱은 Firestore 를 읽는다. 필드 이름의 최종 심판은 앱 레포의 `docs/reference/backend-contract.md`
이며, 이 문서는 그 필드를 **무엇으로 채우는가** 를 정한다.

---

## 1. 계정 · 키 · 쿼터

| 항목 | 값 | 근거 |
| --- | --- | --- |
| 포털 | `data.go.kr` (행정안전부 공공데이터포털) | 활용신청 매뉴얼 I |
| 개발계정 트래픽 | **오퍼레이션별 일일 1,000건** | 활용신청 매뉴얼 II |
| 개발계정 승인 | 자동, 신청 후 10~30분 | 〃 |
| 운영계정 승인 | 공사 담당자 심사, **1~3일** | 활용신청 매뉴얼 IV |
| 운영계정 심사 조건 | 활용 앱/웹 URL + **개발계정 호출 이력** | 〃 |
| 운영계정 활용기간 | 승인일부터 24개월, 연장신청 가능 | 〃 |
| 인증키 재발급 | **포털이 권고하지 않음** | 〃 (포털 Q&A 인용) |
| 데이터 갱신 주기 | 일 1회 (관광정보 서비스 전반) | 각 매뉴얼 서비스 개요 |

### 결론 두 개

**1) 개발계정으로 충분하다.** 우리 호출은 촬영지 수에 비례하고 사용자 수와 무관하다.
장소 100개를 통째로 다시 적재해도 오퍼레이션당 100건 — 1,000건의 10%다.
운영계정은 출시 직전에 신청한다. 심사가 개발계정 호출 이력을 보므로, 개발계정을 먼저 굴려야
신청 자체가 통과한다.

**2) 키는 사실상 회수할 수 없다.**

> **보안:** 활용신청 매뉴얼에 "공공데이터포털에서 인증키 재발급을 권고하지 않음" 이 명시돼
> 있습니다. 즉 이 키가 유출되어도 갈아끼우는 절차가 사실상 없습니다. 앱 번들이나 저장소에 한 번
> 들어가면 되돌릴 방법이 없고, 남이 쿼터를 태우면 현장에서 조회가 죽습니다.
> 키는 `TOURAPI_SERVICE_KEY` 환경변수로만 넘기고 어떤 커밋에도 넣지 않습니다.

적재 스크립트는 배포되는 Cloud Function 이 아니라 개발자 기계에서 도는 도구다. 그래서 지금은
Secret Manager 가 필요 없다. 정기 갱신을 Function 으로 올리게 되면 그때
`defineSecret('TOURAPI_SERVICE_KEY')` 로 옮긴다.

### 호출 공통 규약

- 엔드포인트: `https://apis.data.go.kr/B551011/{서비스ID}/{오퍼레이션}`
  (매뉴얼 표기는 `http` 지만 서비스 개요가 HTTPS 를 지원한다고 명시한다. **HTTPS 를 쓴다**)
- 개발 환경 URL 과 운영 환경 URL 이 **같다**. 계정만 다르다
- 응답 기본 포맷은 XML. **`_type=json` 을 반드시 붙인다**
- 모든 서비스의 필수 파라미터: `serviceKey` · `MobileOS` · `MobileApp`
  - `MobileOS` — `IOS` / `AND` / `WEB` / `ETC`. 서버 적재는 `ETC`
  - `MobileApp` — 활용 통계 집계용. **`Pindom` 으로 고정**한다. 운영계정 심사에서 이 값으로
    호출 이력을 확인한다
- `serviceKey` 는 UTF-8 URL 인코딩해서 보낸다
- 국문 `keyword` 등 한글 파라미터도 인코딩 필요

---

## 2. 서비스 지도 — 무엇이 어디에 속해 있나

매뉴얼 26개는 서비스 20종에 대응한다. 전부 `B551011` 제공기관 아래에 있고, **서비스마다 활용신청이
별개**다. 우리 판정을 붙였다.

### 쓴다

| 서비스ID | 서비스명 | 우리 용도 |
| --- | --- | --- |
| `KorService2` | 국문 관광정보 서비스 | 촬영지 국문 본문 · 좌표 · 이용시간 (§4) |
| `EngService2` | 영문 관광정보 서비스 | 촬영지 영문 본문 (§4) |

### 안 쓴다 — 다국어

| 서비스ID | 서비스명 | 이유 |
| --- | --- | --- |
| `JpnService2` · `ChsService2` · `ChtService2` | 일문 · 중문간체 · 중문번체 | 출시 로케일이 `ko` / `en` 이다. 계약서가 좁혀 확정했다 |
| `GerService2` · `FreService2` · `SpnService2` · `RusService2` | 독 · 불 · 서 · 노 | 〃 |

로케일이 늘면 **서비스ID만 바꾸면 된다.** 오퍼레이션 이름과 파라미터가 국문과 동일하다
(§4 표 참고). 적재 스크립트는 서비스ID를 상수가 아니라 인자로 받게 만든다.

### 안 쓴다 — 주제별 서비스

| 서비스ID | 서비스명 | 이유 |
| --- | --- | --- |
| `KorWithService2` | 국문 무장애여행 | 접근성 정보. 촬영지 도메인과 무관 |
| `GoCamping` | 고캠핑 | 캠핑장 |
| `KorPetTourService2` | 반려동물 동반여행 | 동반 여행 |
| `MdclTursmService` | 의료 관광 | 무관 |
| `WellnessTursmService` | 웰니스 관광 | 무관 |
| `tursmService` | 관광인 채용정보 | 무관 |
| `PhokoAwrdService` | 관광공모전 수상작 | 공모전 사진 |
| `DataLabService` | 관광빅데이터 지역별 방문자수 | 통계. 화면 없음 |
| `AreaTarDivService` · `AreaTarResDemService` · `AreaTarDemDsService` | 지역별 관광 다양성 · 자원수요 · 수요강도 | 통계. 월 1회 갱신. 화면 없음 |
| `LocgoHubTarService1` | 기초지자체 중심관광지 | 지자체 단위 추천. 우리는 큐레이션 |

### 보류 — 나중 후보

지금은 붙일 화면이 없다. 요구가 생기면 이 표부터 본다.

| 서비스ID | 주는 것 | 붙일 만한 자리 |
| --- | --- | --- |
| `TatsCnctrRateService` | **향후 30일 관광지 집중률 예측** | "사람 적은 날 가서 인증하세요" — 성지순례와 궁합이 좋다 |
| `TarRlteTarService1` | 관광지별 연관 관광지 | 코스 자동 확장 후보 |
| `Odii` | 관광지 오디오 가이드 · **이야기(story) 정보** | 촬영지 현장 오디오 |
| `PhotoGalleryService1` | 관광사진갤러리 (URL · 촬영월 · 촬영장소) | 촬영 참고 컷. **단 우리 갤러리와 성격이 다름** — §7 |
| `Durunubi` | 걷기/자전거 길 + **`gpxpath` GPX 경로** | 도보 코스. 다만 둘레길 전용이라 임의 촬영지 간 경로는 못 만든다. 길찾기 API 를 대체하지 못한다 |

---

## 3. `KorService2` 오퍼레이션 13개 — 전수 판정

`EngService2` 는 `detailPetTour2` 만 빠지고 나머지 12개가 같다.

| # | 오퍼레이션 | 국문명 | 판정 |
| --- | --- | --- | --- |
| 1 | `areaBasedList2` | 지역기반 관광정보 조회 | **사람이 손으로** — 큐레이션 |
| 2 | `locationBasedList2` | 위치기반 관광정보 조회 | **사람이 손으로** — 큐레이션 |
| 3 | `searchKeyword2` | 키워드 검색 조회 | **사람이 손으로** — 큐레이션 |
| 4 | `searchFestival2` | 행사정보 조회 | 안 씀 |
| 5 | `searchStay2` | 숙박정보 조회 | 안 씀 |
| 6 | `detailCommon2` | 공통정보 조회 | **적재 — 장소당 1회 (국문·영문 각각)** |
| 7 | `detailIntro2` | 소개정보 조회 | **적재 — 장소당 1회 (국문만)** |
| 8 | `detailInfo2` | 반복정보 조회 | 안 씀 |
| 9 | `detailImage2` | 이미지정보 조회 | 안 씀 — §7 |
| 10 | `areaBasedSyncList2` | 관광정보 동기화 목록 조회 | 안 씀 — §6 에 이유와 대안 |
| 11 | `detailPetTour2` | 반려동물 동반여행 정보 | 안 씀 |
| 12 | `ldongCode2` | 법정동 코드 조회 | 참고용 (§8) |
| 13 | `lclsSystmCode2` | 분류체계 코드 조회 | 참고용 (§8) |

**"사람이 손으로"** 는 촬영지 하나를 목록에 넣을 때 운영자가 브라우저로 한 번 호출해
`contentId` 를 찾는다는 뜻이다. 스크립트에 넣지 않는다. 최애↔촬영지 매핑은 공사에 없는
우리 데이터라 어차피 사람이 판단해야 한다.

---

## 4. 적재 — 장소 1개당 3회 호출

### 4.1 `detailCommon2` (국문) — 본문과 좌표

```
GET https://apis.data.go.kr/B551011/KorService2/detailCommon2
    ?serviceKey={key}&MobileOS=ETC&MobileApp=Pindom&_type=json
    &contentId={contentId}
```

필수는 `serviceKey` · `MobileOS` · `MobileApp` · `contentId` 넷뿐이다.

> **주의.** TourAPI 3.x 의 `overviewYN` · `mapinfoYN` · `addrinfoYN` · `firstImageYN` 플래그는
> **4.0 에 없다.** 요청 파라미터 표에 존재하지 않고, 해당 필드들이 항상 응답에 포함된다.
> 앱 레포 `external-apis.md` §1 이 이 플래그들을 적어둔 것은 3.x 기준이라 무시한다.

| 응답 필드 | `places` 필드 | 처리 |
| --- | --- | --- |
| `title` | `name.ko` | **비어 있을 때만.** 사람이 쓴 이름이 이긴다 — §4.4 |
| `overview` | **`overview.ko`** | **HTML 제거** — 본문에 `<br>` 등이 섞여 온다. `description` 이 아니다 — §4.4 |
| `addr1` (+ `addr2`) | `address` | `addr2` 가 있으면 공백으로 이어 붙인다 |
| `mapx` | `location` 의 **경도** | WGS84 |
| `mapy` | `location` 의 **위도** | WGS84 |
| `firstimage` | — | **안 받는다.** 공사 사진을 쓰지 않기로 했다 — §7 |
| `firstimage2` | — | 썸네일 150×100. 안 쓴다 |
| `cpyrhtDivCd` | — | 저작권 유형. 사진을 안 받으므로 쓸 일이 없다 — §7 |
| `contentid` | `contentId` | 요청한 값과 같은지 확인용 |
| `contenttypeid` | — | **`detailIntro2` 호출에 그대로 넘긴다** |
| `modifiedtime` | — | 콘텐츠 수정일 |
| `homepage` · `tel` · `zipcode` · `mlevel` | — | 안 쓴다 |
| `lDongRegnCd` · `lDongSignguCd` | — | 참고 (§8) |
| `lclsSystm1/2/3` | — | 참고 (§8) |

> **`mapx` 가 경도, `mapy` 가 위도다.** Firestore `GeoPoint` 는 `(위도, 경도)` 순서라
> 그대로 넘기면 뒤집힌다. 뒤집혀도 값이 그럴듯해 보여서 화면에서는 안 드러나고,
> `verifyLocation` 이 `out_of_radius` 를 뱉을 때 처음 발견된다.

### 4.2 `detailCommon2` (영문) — 영문 본문

```
GET https://apis.data.go.kr/B551011/EngService2/detailCommon2
    ?serviceKey={key}&MobileOS=ETC&MobileApp=Pindom&_type=json
    &contentId={contentId}
```

> **`contentId` 가 국문과 다르다.** 영문 서비스는 같은 장소를 별도 번호로 들고 있다.
> 남산서울타워는 국문 `126535` · 영문 `264550`, 감천문화마을은 `1997221` · `1998211` 이다.
> 좌표는 소수점 아래까지 일치해서 짝을 찾을 때 그걸로 확인한다.
>
> **국문 번호로 영문 서비스를 부르면 에러가 나지 않는다.** `resultCode: "0000"` 에
> `totalCount: 0` 이 와서, 그 장소가 영문 DB 에 없는 것처럼 조용히 넘어간다. 실제로 첫 실행에서
> 네 장소 전부가 "영문 없음" 으로 찍혔고 그게 오해였다.
>
> 그래서 영문 번호는 `places.contentIdEn` 에 **사람이 따로 적는다.** 좌표로 자동 매칭하지
> 않는다 — 을왕리해수욕장은 국문·영문 등록 좌표가 95m 어긋나 있고, 주문진에는 방파제·해변·항
> 세 콘텐츠가 3km 안에 몰려 있다. 자동 매칭은 조용히 다른 장소를 집는다.

| 응답 필드 | `places` 필드 | 처리 |
| --- | --- | --- |
| `title` | `name.en` | 비어 있을 때만. 꼬리의 한글 원제를 뗀다 — `N Seoul Tower (남산서울타워)` → `N Seoul Tower`. `[Tax Refund Shop]` 같은 영문 괄호는 정보라 남긴다 |
| `overview` | **`overview.en`** | 태그 제거 + 엔티티 복원 |

응답이 없거나 비면 **`name.en` · `description.en` 을 만들지 않는다.** 계약서의 absent 규칙대로
키가 없으면 앱이 `ko` 로 폴백한다. 빈 문자열을 넣으면 화면이 빈칸으로 뜬다.

좌표·주소는 국문 응답의 것을 쓴다. 영문 응답의 좌표를 다시 읽지 않는다 — 판정 기준 좌표가
두 곳에서 오면 어긋날 자리가 생긴다.

### 4.3 `detailIntro2` (국문) — 이용시간과 휴무일

```
GET https://apis.data.go.kr/B551011/KorService2/detailIntro2
    ?serviceKey={key}&MobileOS=ETC&MobileApp=Pindom&_type=json
    &contentId={contentId}&contentTypeId={contenttypeid}
```

**`contentTypeId` 가 필수**다. 4.1 응답의 `contenttypeid` 를 그대로 넘긴다.
응답 필드가 타입마다 다르다 — 촬영지는 대개 관광지(`12`)다.

`contentTypeId=12` 응답 중 우리가 보는 것:

| 응답 필드 | `places` 필드 | 비고 |
| --- | --- | --- |
| `usetime` | `openHours.ko` | "상시 개방" 같은 자유 문자열. **구조화된 시간이 아니다** |
| `restdate` | `closedDays.ko` | "연중무휴" 등 |
| `parking` · `infocenter` · `chkpet` · `chkbabycarriage` · `accomcount` · `expguide` · `heritage1~3` · `opendate` · `useseason` | — | 안 쓴다. 화면이 요구하면 그때 |

`usetime` · `restdate` 는 사람이 읽는 문장이지 파싱 대상이 아니다. **여기서 영업 여부를 계산하지
않는다.** 그대로 띄운다.

영문 이용시간은 받지 않는다. `EngService2/detailIntro2` 를 한 번 더 부르면 되지만, 호출이
장소당 4회로 늘고 자유 문자열이라 폴백해도 손해가 적다.

### 4.4 절대 공사 값으로 덮지 않는 필드

| 필드 | 이유 |
| --- | --- |
| `artistIds` | 최애↔촬영지 매핑. 공사에 없다. 이 앱의 핵심 데이터 |
| `workTitle` · `workKind` | 어떤 뮤비/드라마에 나왔는지. 공사에 없다 |
| `radiusMeters` | 인증 반경. 장소마다 우리가 조정한다 |
| `region` | `강원 강릉` 처럼 짧게 다듬은 표기 + 영문. `addr1` 과 용도가 다르다 |
| `description` | **성격이 다른 글이다.** 공사 개요는 "그 관광지" 소개고, 우리 설명은 "자물쇠 벽 앞이 인증샷 포인트" 처럼 촬영하러 가는 사람에게 필요한 말이다. 공사 개요는 `overview` 로 따로 받아 화면의 **더 자세한 설명 보기**에 넣는다 |
| `name` | 반만 지킨다 — 사람이 쓴 로케일은 그대로 두고 **빈 로케일만** 공사 값으로 채운다. 촬영 지점이 `N서울타워 전망대` 인데 공사 등록명은 `남산서울타워` 라, 우리 이름이 더 정확한 자리가 있다 |
| `roman` | 라틴 캡션 |
| 모든 카운터 | `ticketCount` · `verifyCount` · `photoCount` · `reviewCount` 는 함수 소유 |

| `coverImageUrl` | 자체 컷. 공사 사진은 받지 않는다 — §7 |

---

## 5. 적재 절차

```
사람   seed-data.json 의 장소에 contentId 와 큐레이션 필드를 적는다
  ↓
스크립트  §4 의 3콜 → 같은 파일의 나머지 필드를 채워 되쓴다
  ↓
사람   git diff 로 공사가 준 값을 눈으로 검수한다
  ↓
seed.mjs  Firestore 에 적재 (기존 경로 그대로)
```

키는 저장소 루트의 `.env.local` 에 한 줄로 둔다. `.gitignore` 가 `.env.local` 을 막고 있고,
npm 스크립트가 `node --env-file-if-exists` 로 읽는다 — dotenv 의존성이 없다.

```
TOURAPI_SERVICE_KEY=발급받은키          # pindom-server/.env.local
```

```
npm --prefix functions run import-tourapi -- --dry-run
npm --prefix functions run import-tourapi
npm --prefix functions run seed -- --project pindom-1234 --yes
```

Firestore 에 쓰는 경로를 새로 만들지 않는다. `scripts/seed.mjs` 의 `upsert()` 가 이미
카운터를 `initialOnly` 로 분리해 재실행에 안전하고, 그것이 `places` 의 유일한 쓰기 주체다.
적재 전에 diff 로 검수가 된다는 점이 덤이 아니라 핵심이다 — 외부 데이터가 DB 에 바로 꽂히지
않는다.

**호출 예산:** 장소 N개 → `KorService2/detailCommon2` N + `EngService2/detailCommon2` N +
`KorService2/detailIntro2` N. 서비스·오퍼레이션 단위로 각각 N건이라 1,000건 한도에서
장소 1,000개까지 하루에 소화된다.

---

## 6. 갱신

공사 데이터는 **일 1회** 갱신된다. 우리 촬영지 정보(이름·개요·좌표)는 거의 안 바뀐다.

**정기 동기화를 만들지 않는다.** 필요할 때 스크립트를 다시 돌리면 N개를 통째로 다시 받는다.
장소 수가 세 자리를 넘지 않는 동안은 이게 가장 짧다.

`areaBasedSyncList2` 를 쓰지 않는 이유와, 나중에 쓰게 될 때 얻는 것:

| 파라미터 / 필드 | 주는 것 |
| --- | --- |
| `modifiedtime` (YYYYMMDD) | 그 날 이후 바뀐 콘텐츠만 | 
| `showflag` | `1`=표출, `0`=비표출. **콘텐츠가 내려갔는지** 알 수 있다 |
| `oldContentid` | "DB저장 동기화시 이전 KEY 값으로 조회 용도" — **`contentId` 는 바뀔 수 있다** |

여기서 나오는 규칙 두 개는 지금부터 지킨다:

1. **`contentId` 는 영구 키가 아니다.** `detailCommon2` 가 `NODATA_ERROR`(03) 를 주면 콘텐츠가
   재발급됐거나 내려간 것이다. 이때 **문서를 지우지 않는다.** 촬영지는 물리적으로 그 자리에
   있고 티켓 이력이 걸려 있다. 사람이 다시 큐레이션하도록 표시만 남긴다
2. `showflag=0` 도 마찬가지다. 공사 화면에서 내려갔을 뿐 촬영지가 사라진 게 아니다

---

## 7. 이미지 — 받지 않는다

**공사 사진을 쓰지 않기로 했다.** `detailCommon2` 의 `firstimage` 도, `detailImage2` 도
호출하지 않는다. `coverImageUrl` 은 사람이 채우는 필드다.

이유는 저작권이다. 공사 이미지에는 `cpyrhtDivCd` 가 붙는다 — `Type1` 은 출처 표시,
`Type3` 은 거기에 더해 **가공 금지**다. 크롭·필터·오버레이가 걸린다. 커버 이미지는 화면
비율에 맞춰 잘리는 자리라 `Type3` 과 맞지 않고, 쓰지 않을 이미지 때문에 모든 장소 상세에
출처 표시 자리를 만들 이유도 없다.

`detailImage2` 는 그와 별개로도 안 쓴다. `places/{placeId}/gallery` 는 `issueTicket` 이
쓰는 **인증한 사용자의 사진 벽**이고, 공사 사진을 같은 컬렉션에 섞으면 "인증한 사람만 올린
벽" 이라는 성질 자체가 사라진다.

## 8. 코드 체계

### 8.1 `contentTypeId` — 국문과 다국어가 다르다

`detailIntro2` 가 이 값을 요구하므로 실제로 걸린다. 국문 응답의 `contenttypeid` 를 다국어
서비스에 그대로 넘기면 안 된다.

| 타입 | 국문 (`KorService2`) | 다국어 (`EngService2` 등) |
| --- | --- | --- |
| 관광지 | **12** | **76** |
| 문화시설 | 14 | 78 |
| 행사/공연/축제 | 15 | 85 |
| 여행코스 | 25 | 국문만 서비스 |
| 레포츠 | 28 | 75 |
| 숙박 | 32 | 80 |
| 쇼핑 | 38 | 79 |
| 음식점 | 39 | 82 |
| 교통 | 없음 | 77 (다국어만) |

우리는 다국어 쪽에서 `detailIntro2` 를 부르지 않으므로 지금은 국문 코드만 쓴다.
영문 이용시간을 받게 되면 이 표로 변환해야 한다.

출처: `docs/api_docs/신분류체계정보 관광타입정보 연계 정의서.xlsx`,
국문 매뉴얼 §III-2, 영문 매뉴얼 §III-2.

### 8.2 지역 코드 — `areaCode` 는 없어졌다

TourAPI 4.0 의 `*2` 오퍼레이션은 `areaCode` · `sigunguCode` 를 받지 않는다.
**`lDongRegnCd`(시도, 2자리) · `lDongSignguCd`(시군구, 3자리)** 로 바뀌었다. 법정동 체계다.

- 코드는 `ldongCode2` 오퍼레이션으로 조회한다. `lDongListYn=Y` 면 전체 목록
- `docs/api_docs/한국관광공사_OpenAPI_관광지_시군구_코드정보_v1.0.xlsx` 도 같은 표다.
  단 엑셀은 `sigunguCd` 를 5자리(`11110`)로, API 는 3자리(`110`)로 준다. **API 값이 기준**이다
- 코드 테이블을 레포에 복사하지 않는다. 큐레이션은 사람이 하고, 사람은 엑셀을 열면 된다

### 8.3 분류체계 `lclsSystm1/2/3`

`AC`(숙박) · `EV`(축제/공연/행사) · `VE` · `FD` · `SH` · `NA` 같은 대분류 아래 3단계.
`lclsSystmCode2` 로 조회한다. **필터로 쓰지 않는다** — `contentId` 로 콕 집으므로 필요가 없다.

---

## 9. 계약서에 미치는 영향

앱 레포 `docs/reference/backend-contract.md` 의 `places` 에 대한 변경. **앱 개발자 합의 필요.**

| 필드 | 상태 | 값 |
| --- | --- | --- |
| `contentId` | **반영됨** | `KorService2` 의 `contentid`. 재적재 중복 판정 키. 손등록 장소는 생략 |
| `contentIdEn` | **추가 제안** | `EngService2` 의 `contentid`. 국문과 다른 값이다 (§4.2). 없으면 영문 본문을 받지 않는다 |
| `openHours` | **추가 제안** | `LocalizedString`. `detailIntro2.usetime`. 자유 문장. 없으면 생략 |
| `closedDays` | **추가 제안** | `LocalizedString`. `detailIntro2.restdate`. 없으면 생략 |
| `coverImageLicense` | **추가 제안** | `'Type1' \| 'Type3'`. 공사 이미지를 커버로 쓸 때만 존재. 있으면 화면이 출처를 표시하고, `Type3` 이면 가공하지 않는다 (§7) |

`firestore.rules` 는 손대지 않는다. `places` 는 `read: signedIn()` / `write: false` 라 필드를
나열하지 않는다.

---

## 10. 미확인 — 붙일 때 확인할 것

매뉴얼로 확정되지 않은 것들. 확인하고 이 절을 지운다.

> **확인 완료 (2026-08-26).** 국문·영문의 `contentId` 는 **다르다.** §4.2 참고. 영문 본문은
> `contentIdEn` 을 따로 적어 받는다.

1. **영문 DB 커버리지.** 첫 4개는 전부 영문 콘텐츠가 있었다. 무명 촬영지에서 없을 수 있고,
   그때 폴백이 동작하는지(`name.en` 부재 → `ko` 표시) 앱에서 확인
2. **엔티티 목록.** 영문 개요가 `&ldquo;` `&rsquo;` 같은 타이포그래피 엔티티를 보낸다.
   스크립트가 쓰는 것만 표로 갖고 있어서, 모르는 엔티티는 원문 그대로 남는다. 새 장소를 넣을 때
   `&...;` 가 본문에 남아 있는지 diff 에서 본다
3. **`usetime` 의 실제 값 분포.** 야외 촬영지는 대부분 빈 값일 것으로 보이는데, 그렇다면
   `openHours` 필드가 실제로 채워지는 비율이 낮다

---

## 부록 — 에러 코드

`resultCode` 가 `0000` 이 아니면 응답 본문이 없다. 적재 스크립트는 아래를 구분해야 한다.

| 코드 | 메시지 | 우리 대응 |
| --- | --- | --- |
| `00` / `0000` | `NORMAL_CODE` / OK | 정상 |
| `03` | `NODATA_ERROR` | **콘텐츠 없음.** §6 — 지우지 말고 재큐레이션 표시 |
| `10` | `INVALID_REQUEST_PARAMETER_ERROR` | 파라미터 오류. 스크립트 버그 |
| `11` | `NO_MANDATORY_REQUEST_PARAMETERS_ERROR` | 필수 파라미터 누락 |
| `22` | `LIMITED_NUMBER_OF_SERVICE_REQUESTS_EXCEEDS_ERROR` | **쿼터 초과.** 중단하고 다음 날 |
| `30` | `SERVICE_KEY_IS_NOT_REGISTERED_ERROR` | 키 미등록 — 인코딩 문제이거나 해당 서비스 미신청 |
| `31` | `DEADLINE_HAS_EXPIRED_ERROR` | 활용기간 만료. 연장신청 |
| `32` | `UNREGISTERED_IP_ERROR` | 등록되지 않은 IP |
| `05` | `SERVICETIMEOUT_ERROR` | 재시도 |

포털 계층 에러(`SERVICE ERROR` 등)는 **`_type=json` 을 붙여도 XML 로 온다.**
JSON 파싱 실패를 곧 실패로 처리하지 말고 본문을 로그에 남긴다.
