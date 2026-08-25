// TourAPI 응답 → seed-data.json 매핑. 네트워크도 에뮬레이터도 필요 없다.
//
//   node --test functions/test/import-tourapi.test.mjs
//
// 좌표가 뒤집혀도 값은 그럴듯해 보인다. 그게 여기서 잡아야 하는 이유다.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { englishTitle, firstItem, mergePlace, stripHtml } from '../scripts/import-tourapi.mjs';

// 주문진 근처 좌표. 공사 응답은 문자열로 온다.
const KO = {
  contentid: '126508',
  contenttypeid: '12',
  title: '주문진 방파제',
  overview: '바다를 등지고 서면 방파제 끝까지 한 프레임에 들어옵니다.<br>파도가 높은 날은 통제돼요.',
  addr1: '강원특별자치도 강릉시 주문진읍 해안로 1609',
  addr2: '(주문진읍)',
  mapx: '128.8306',
  mapy: '37.8983',
  firstimage: 'https://tong.visitkorea.or.kr/cms/resource/00/1_image2_1.jpg',
  cpyrhtDivCd: 'Type3',
};

const EN = { title: 'Jumunjin Breakwater (주문진 방파제)', overview: 'The whole breakwater fits in one frame.' };
const INTRO = { usetime: '상시 개방', restdate: '연중무휴' };

const PLACE = {
  id: 'place-jumunjin',
  contentId: '126508',
  artistIds: ['artist-lumina'],
  workTitle: { ko: '도깨비', en: 'Goblin' },
  workKind: 'mv',
  radiusMeters: 50,
  region: { ko: '강원 강릉', en: 'Gangneung, Gangwon' },
  roman: 'Jumunjin Breakwater',
  coverImageUrl: 'https://picsum.photos/seed/jumunjin/1200/800',
};

describe('stripHtml', () => {
  it('태그를 걷고 공백을 정리한다', () => {
    assert.equal(stripHtml('가<br>나  다'), '가 나 다');
    assert.equal(stripHtml('<span style="font-size:11pt">길</span>'), '길');
  });

  it('엔티티를 되돌린다', () => {
    assert.equal(stripHtml('바다&amp;산'), '바다&산');
    // 영문 개요가 실제로 이렇게 온다.
    assert.equal(stripHtml('the show &ldquo;Guardian&rdquo;'), 'the show \u201cGuardian\u201d');
    assert.equal(stripHtml('the leads&rsquo; meeting'), 'the leads\u2019 meeting');
    assert.equal(stripHtml('&#65;&#x42;'), 'AB');
  });

  it('모르는 엔티티는 그대로 둔다', () => {
    assert.equal(stripHtml('a &zzz; b'), 'a &zzz; b');
  });

  it('빈 값에서 터지지 않는다', () => {
    assert.equal(stripHtml(undefined), '');
  });
});

describe('englishTitle', () => {
  it('한글 원제 꼬리를 뗀다', () => {
    assert.equal(englishTitle('N Seoul Tower (남산서울타워)'), 'N Seoul Tower');
    assert.equal(englishTitle('Busan Gamcheon Culture Village (부산 감천문화마을)'),
      'Busan Gamcheon Culture Village');
  });

  it('영문 괄호는 정보라 남긴다', () => {
    assert.equal(englishTitle('Gamcheon Gift Shop [Tax Refund Shop]'),
      'Gamcheon Gift Shop [Tax Refund Shop]');
    assert.equal(englishTitle('Seoul Tower (Observatory)'), 'Seoul Tower (Observatory)');
  });

  it('꼬리가 아닌 한글 괄호는 두고, 마지막 것만 뗀다', () => {
    assert.equal(englishTitle('Tower (남산) Annex'), 'Tower (남산) Annex');
  });
});

describe('firstItem', () => {
  const wrap = (resultCode, item) => ({
    response: { header: { resultCode, resultMsg: 'x' }, body: { items: item ? { item } : '' } },
  });

  it('배열로 와도 하나를 꺼낸다', () => {
    assert.equal(firstItem(wrap('0000', [KO, {}])).title, '주문진 방파제');
  });

  it('데이터 없음(03)은 던지지 않고 null 이다', () => {
    assert.equal(firstItem(wrap('03')), null);
  });

  it('쿼터 초과(22)는 던진다', () => {
    assert.throws(() => firstItem(wrap('22')), /22/);
  });
});

describe('mergePlace', () => {
  it('mapx 는 경도, mapy 는 위도로 들어간다', () => {
    const next = mergePlace(PLACE, { ko: KO, en: EN, intro: INTRO });
    // 뒤집히면 lat 128 이 되어 지구 밖으로 나간다.
    assert.equal(next.lat, 37.8983);
    assert.equal(next.lng, 128.8306);
  });

  it('사람이 쓴 필드는 공사 응답이 있어도 그대로다', () => {
    const next = mergePlace(PLACE, { ko: KO, en: EN, intro: INTRO });
    assert.deepEqual(next.artistIds, ['artist-lumina']);
    assert.deepEqual(next.region, PLACE.region);
    assert.equal(next.radiusMeters, 50);
    assert.equal(next.workKind, 'mv');
  });

  it('본문과 이용시간을 채우고 개요의 태그를 걷는다', () => {
    const next = mergePlace(PLACE, { ko: KO, en: EN, intro: INTRO });
    assert.equal(next.name.ko, '주문진 방파제');
    assert.equal(next.name.en, 'Jumunjin Breakwater');
    assert.ok(!next.description.ko.includes('<br>'));
    assert.equal(next.address, '강원특별자치도 강릉시 주문진읍 해안로 1609 (주문진읍)');
    assert.deepEqual(next.openHours, { ko: '상시 개방' });
    assert.deepEqual(next.closedDays, { ko: '연중무휴' });
  });

  it('커버 이미지를 받으면 저작권 유형을 함께 남긴다', () => {
    const next = mergePlace(PLACE, { ko: KO, en: EN, intro: INTRO });
    assert.equal(next.coverImageUrl, KO.firstimage);
    assert.equal(next.coverImageLicense, 'Type3');
  });

  it('firstimage 가 비면 있던 커버를 지우지 않는다', () => {
    const next = mergePlace(PLACE, { ko: { ...KO, firstimage: '', cpyrhtDivCd: '' }, en: EN, intro: INTRO });
    assert.equal(next.coverImageUrl, PLACE.coverImageUrl);
    // 우리 이미지에 공사 저작권을 붙이면 잘못된 출처 표시가 뜬다.
    assert.equal(next.coverImageLicense, undefined);
  });

  it('영문 응답이 없으면 name.en 을 만들지 않는다', () => {
    const next = mergePlace(PLACE, { ko: KO, en: null, intro: INTRO });
    assert.equal(next.name.en, undefined);
    assert.equal(next.description.en, undefined);
  });

  it('이용시간이 비면 필드를 만들지 않는다', () => {
    const next = mergePlace(PLACE, { ko: KO, en: EN, intro: { usetime: '', restdate: '' } });
    assert.equal(next.openHours, undefined);
    assert.equal(next.closedDays, undefined);
  });

  it('좌표가 0 이면 기존 값을 지키지 않고 무시한다', () => {
    const seeded = { ...PLACE, lat: 37.8983, lng: 128.8306 };
    const next = mergePlace(seeded, { ko: { ...KO, mapx: '', mapy: '' }, en: EN, intro: INTRO });
    assert.equal(next.lat, 37.8983);
    assert.equal(next.lng, 128.8306);
  });
});
