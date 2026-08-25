/**
 * TourAPI 4.0 에서 촬영지 정보를 받아 seed-data.json 을 채운다.
 *
 *   TOURAPI_SERVICE_KEY=... node scripts/import-tourapi.mjs --dry-run
 *   TOURAPI_SERVICE_KEY=... node scripts/import-tourapi.mjs
 *
 * Firestore 에 직접 쓰지 않는다. seed-data.json 을 고쳐 두면 git diff 로 공사가 준 값을
 * 눈으로 검수한 뒤 기존 seed.mjs 가 적재한다. 외부 데이터가 DB 에 바로 꽂히지 않는 것이
 * 이 구조의 요점이다.
 *
 * 무엇을 어디서 받아 어디에 넣는지는 docs/tourapi-usage.md §4 가 원본이다.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const BASE = 'https://apis.data.go.kr/B551011';
const COMMON = { MobileOS: 'ETC', MobileApp: 'Pindom', _type: 'json' };

// 공사가 주는 값으로 절대 덮지 않는다. 최애 매핑도 인증 반경도 공사에는 없는 우리 판단이다.
const OURS = ['id', 'contentId', 'contentIdEn', 'artistIds', 'workTitle', 'workKind', 'radiusMeters', 'region', 'roman'];

// 영문 개요는 &ldquo; &rsquo; 같은 타이포그래피 엔티티를 그대로 보낸다. 화면에 날문자가
// 뜨는 자리라 여기서 되돌린다. Node 에 HTML 엔티티 디코더가 없어 쓰는 것만 적는다.
const ENTITIES = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  ldquo: '\u201c', rdquo: '\u201d', lsquo: '\u2018', rsquo: '\u2019',
  mdash: '\u2014', ndash: '\u2013', hellip: '\u2026', middot: '\u00b7', deg: '\u00b0',
};

/** 개요에 <br> 과 <span style=...> 이 섞여 온다. 태그를 걷고 엔티티를 되돌린다. */
export function stripHtml(text) {
  if (!text) return '';
  return text
    .replace(/<[^>]*>/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (whole, name) => ENTITIES[name.toLowerCase()] ?? whole)
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 영문 서비스의 title 은 "N Seoul Tower (남산서울타워)" 처럼 한글 원제를 괄호로 달고 온다.
 * 영어 화면에 한글이 따라붙으면 그대로 드러나는 자리라 꼬리만 떼어낸다.
 */
export function englishTitle(title) {
  if (!title) return '';
  return title.replace(/\s*\([^()]*[\uac00-\ud7a3][^()]*\)\s*$/, '').trim();
}

/**
 * 응답에서 item 하나를 꺼낸다. resultCode 가 정상이 아니면 던지고, 데이터 없음(03)만
 * null 로 돌려준다 — 콘텐츠가 재발급됐거나 내려간 경우이고, 그때 문서를 지우면 안 된다.
 */
export function firstItem(json) {
  const header = json?.response?.header ?? {};
  const code = String(header.resultCode ?? '');
  if (code === '03') return null;
  if (code !== '0000' && code !== '00') {
    throw new Error(`TourAPI ${code} ${header.resultMsg ?? ''}`.trim());
  }
  const item = json?.response?.body?.items?.item;
  if (!item) return null;
  return Array.isArray(item) ? item[0] : item;
}

/**
 * 공사 응답 셋을 기존 장소에 얹는다. 사람이 쓴 필드는 건드리지 않고, 공사가 빈 값을 준
 * 자리는 있던 값을 남긴다 — 갱신 한 번에 커버 이미지가 사라지면 안 된다.
 */
export function mergePlace(place, { ko, en, intro }) {
  const next = { ...place };
  if (ko) {
    if (ko.title) next.name = { ...next.name, ko: ko.title };
    const overview = stripHtml(ko.overview);
    if (overview) next.description = { ...next.description, ko: overview };

    const address = [ko.addr1, ko.addr2].filter(Boolean).join(' ').trim();
    if (address) next.address = address;

    // mapx 가 경도, mapy 가 위도다. GeoPoint 는 (위도, 경도) 순이라 뒤집기 쉬운 자리다.
    const lng = Number(ko.mapx);
    const lat = Number(ko.mapy);
    if (Number.isFinite(lat) && Number.isFinite(lng) && lat !== 0 && lng !== 0) {
      next.lat = lat;
      next.lng = lng;
    }

    if (ko.firstimage) {
      next.coverImageUrl = ko.firstimage;
      // 공공누리 유형. Type3 은 출처표시 + 변경금지라 앱이 가공하면 안 된다.
      if (ko.cpyrhtDivCd) next.coverImageLicense = ko.cpyrhtDivCd;
    }
  }

  if (en) {
    // 영문이 비면 키를 만들지 않는다. LocalizedString 은 키가 없어야 앱이 ko 로 폴백한다.
    const title = englishTitle(en.title);
    if (title) next.name = { ...next.name, en: title };
    const overview = stripHtml(en.overview);
    if (overview) next.description = { ...next.description, en: overview };
  }

  if (intro) {
    // usetime·restdate 는 "상시 개방" 같은 사람이 읽는 문장이다. 파싱하지 않고 그대로 둔다.
    const openHours = stripHtml(intro.usetime);
    if (openHours) next.openHours = { ...next.openHours, ko: openHours };
    const closedDays = stripHtml(intro.restdate);
    if (closedDays) next.closedDays = { ...next.closedDays, ko: closedDays };
  }

  for (const key of OURS) {
    if (key in place) next[key] = place[key];
    else delete next[key];
  }
  return next;
}

async function call(service, operation, params, serviceKey) {
  const url = new URL(`${BASE}/${service}/${operation}`);
  for (const [k, v] of Object.entries({ ...COMMON, ...params })) url.searchParams.set(k, v);
  // serviceKey 는 포털이 이미 인코딩된 문자열로 준다. searchParams 에 넣으면 이중 인코딩된다.
  const res = await fetch(`${url}&serviceKey=${serviceKey}`);
  const body = await res.text();
  // 포털 계층 에러는 _type=json 을 붙여도 XML 로 온다. 파싱 실패로 뭉개면 원인이 안 보인다.
  if (body.trimStart().startsWith('<')) {
    throw new Error(`포털 에러 응답 (HTTP ${res.status}): ${body.slice(0, 300)}`);
  }
  return firstItem(JSON.parse(body));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const serviceKey = process.env.TOURAPI_SERVICE_KEY;
  if (!serviceKey) {
    console.error('TOURAPI_SERVICE_KEY 가 없습니다. 셸 환경변수로 넘기세요 (커밋 금지).');
    process.exit(1);
  }
  const dryRun = process.argv.includes('--dry-run');

  const here = dirname(fileURLToPath(import.meta.url));
  const path = join(here, 'seed-data.json');
  const data = JSON.parse(readFileSync(path, 'utf8'));

  let filled = 0;
  let missing = 0;
  const skipped = [];

  for (const [i, place] of data.places.entries()) {
    if (!place.contentId) {
      skipped.push(place.id);
      continue;
    }
    const contentId = String(place.contentId);

    const ko = await call('KorService2', 'detailCommon2', { contentId }, serviceKey);
    if (!ko) {
      // contentId 는 영구 키가 아니다. 공사가 콘텐츠를 재발급하면 바뀌고, 내려가도 사라진다.
      // 촬영지는 그 자리에 그대로 있고 티켓 이력도 걸려 있으므로 문서를 비우지 않는다.
      console.warn(`  ! ${place.id}: contentId ${contentId} 조회 결과 없음 — 재큐레이션 필요`);
      missing += 1;
      continue;
    }
    await sleep(200);

    // 영문 서비스는 같은 장소를 다른 contentId 로 들고 있다. 국문 번호로 부르면 조용히
    // 빈 응답(0000 / totalCount 0)이 와서 영문이 없는 장소처럼 보인다. 짝은 사람이 적는다.
    const en = place.contentIdEn
      ? await call('EngService2', 'detailCommon2', { contentId: String(place.contentIdEn) }, serviceKey)
      : null;
    if (place.contentIdEn && !en) {
      console.warn(`  ! ${place.id}: 영문 contentId ${place.contentIdEn} 조회 결과 없음`);
    }
    await sleep(200);

    const intro = ko.contenttypeid
      ? await call('KorService2', 'detailIntro2', { contentId, contentTypeId: ko.contenttypeid }, serviceKey)
      : null;
    await sleep(200);

    data.places[i] = mergePlace(place, { ko, en, intro });
    filled += 1;
    const enNote = en ? '' : place.contentIdEn ? ' [영문 조회 실패]' : ' [영문 contentIdEn 없음]';
    console.log(`  ${place.id} ← ${ko.title} (${ko.mapy}, ${ko.mapx})${enNote}`);
  }

  if (!dryRun) writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);

  console.log(`\n${filled}건 채움${missing ? `, ${missing}건 조회 실패` : ''}`);
  if (skipped.length) console.log(`  contentId 없어 건너뜀: ${skipped.join(', ')}`);
  console.log(dryRun ? '  --dry-run 이라 파일은 그대로다.' : '  git diff scripts/seed-data.json 으로 검수하세요.');
}

// ponytail: 전량 재조회. 증분 동기화(areaBasedSyncList2)를 쓰지 않는다.
// 촬영지 정보는 일 1회 갱신이고 장소 수가 세 자리를 넘지 않는다. 넘어가면 그때 modifiedtime
// 필터와 스케줄 Function + defineSecret 으로 올린다. docs/tourapi-usage.md §6.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
