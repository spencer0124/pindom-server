// 판정 로직 단위 테스트. 에뮬레이터가 필요 없다.
//
//   npm --prefix functions run build && node --test functions/test/logic.test.mjs
//
// 값 하나로 티켓이 나오고 안 나오고가 갈리는 경계만 담는다.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ACCURACY_GATE_M,
  SPEED_TRIGGER_M,
  SESSION_SPEED_KMH,
  distanceMeters,
  effectiveDistance,
  impliedSpeedKmh,
  isImplausibleJump,
  mintSerial,
  normalizeArtist,
  normalizeBoard,
  normalizePlace,
  containsBanned,
  tierFor,
} from '../lib/logic.js';

const SEOUL = { lat: 37.5665, lng: 126.978 };
const BUSAN = { lat: 35.1796, lng: 129.0756 };

describe('distanceMeters', () => {
  it('서울–부산은 약 325km', () => {
    const km = distanceMeters(SEOUL, BUSAN) / 1000;
    assert.ok(km > 318 && km < 332, `${km}km`);
  });

  it('같은 지점은 0', () => {
    assert.equal(distanceMeters(SEOUL, SEOUL), 0);
  });
});

describe('effectiveDistance', () => {
  it('오차 반경을 빼고 판정한다 — 60m 지점의 15m 오차는 45m', () => {
    assert.equal(effectiveDistance(60, 15), 45);
  });

  it('오차가 거리보다 크면 0 이지 음수가 아니다', () => {
    assert.equal(effectiveDistance(10, 65), 0);
  });
});

describe('isImplausibleJump', () => {
  it(`${SPEED_TRIGGER_M}m 미만은 계산하지 않는다 — GPS 흔들림이다`, () => {
    // 199m 를 1초에 옮겨도 흔들림 범위라 통과한다.
    assert.equal(isImplausibleJump(199, 1, SESSION_SPEED_KMH), false);
  });

  it('201m 를 3초에 옮기면 240km/h — 거부', () => {
    assert.equal(Math.round(impliedSpeedKmh(201, 3)), 241);
    assert.equal(isImplausibleJump(201, 3, SESSION_SPEED_KMH), true);
  });

  it('걸어서 250m 를 5분에 옮기는 것은 통과', () => {
    assert.equal(isImplausibleJump(250, 300, SESSION_SPEED_KMH), false);
  });

  it('시각이 거꾸로 오면 판정하지 않는다', () => {
    assert.equal(isImplausibleJump(5000, -10, SESSION_SPEED_KMH), false);
  });
});

describe('tierFor', () => {
  it('구간 경계', () => {
    assert.equal(tierFor(0), 'club10');
    assert.equal(tierFor(19), 'club10');
    assert.equal(tierFor(20), 'club20');
    assert.equal(tierFor(29), 'club20');
    assert.equal(tierFor(30), 'clubGo');
  });
});

describe('mintSerial', () => {
  const serial = mintSerial(Uint8Array.from([255, 0, 128, 17, 42, 200, 7, 99]));

  it('PD-XXXX-XXXX-XXXX 형식', () => {
    assert.match(serial, /^PD-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
  });

  it('혼동되는 I·L·O·U 를 쓰지 않는다', () => {
    assert.doesNotMatch(serial, /[ILOU]/);
  });

  it('같은 바이트는 같은 시리얼', () => {
    assert.equal(mintSerial(Uint8Array.from([255, 0, 128, 17, 42, 200, 7, 99])), serial);
  });

  it('바이트가 모자라면 던진다', () => {
    assert.throws(() => mintSerial(Uint8Array.from([1, 2, 3])));
  });
});

describe('상수', () => {
  it('정확도 게이트는 65m — 도심 안드로이드 실측을 흡수하는 값', () => {
    assert.equal(ACCURACY_GATE_M, 65);
  });
});

describe('normalizeBoard', () => {
  const artist = { boardId: 'artist-lumina', kind: 'artist', name: { ko: '루미나', en: 'Lumina' } };

  it('아이돌 게시판은 artistId 가 문서 id 와 같고 기본값이 채워진다', () => {
    const { boardId, doc } = normalizeBoard(artist);
    assert.equal(boardId, 'artist-lumina');
    assert.equal(doc.artistId, 'artist-lumina');
    assert.equal(doc.order, 0);
    assert.equal(doc.archived, false);
  });

  it('자유게시판은 id 가 free 일 때만, free 는 자유게시판일 때만', () => {
    assert.throws(() => normalizeBoard({ ...artist, kind: 'free' }));
    assert.throws(() => normalizeBoard({ ...artist, boardId: 'free' }));
    assert.doesNotThrow(() => normalizeBoard({ ...artist, boardId: 'free', kind: 'free' }));
  });

  it('자유게시판은 보관할 수 없다 — 앱의 기본 탭이 사라진다', () => {
    assert.throws(() => normalizeBoard({ boardId: 'free', kind: 'free', name: artist.name, archived: true }));
  });

  it('이름은 ko·en 이 둘 다 있어야 하고, 설명은 있으면 둘 다여야 한다', () => {
    assert.throws(() => normalizeBoard({ ...artist, name: { ko: '루미나' } }));
    assert.throws(() => normalizeBoard({ ...artist, name: { ko: ' ', en: 'Lumina' } }));
    assert.throws(() => normalizeBoard({ ...artist, description: { ko: '설명' } }));
    assert.equal(normalizeBoard(artist).doc.description, undefined);
  });

  it('문서 id 와 강조색은 형식을 본다', () => {
    assert.throws(() => normalizeBoard({ ...artist, boardId: 'a/b' }));
    assert.throws(() => normalizeBoard({ ...artist, accentColor: 'green' }));
    assert.equal(normalizeBoard({ ...artist, accentColor: '#58CF04' }).doc.accentColor, '#58CF04');
  });
});

describe('normalizeArtist', () => {
  const input = { artistId: 'artist-lumina', name: { ko: '루미나', en: 'Lumina' } };

  it('아이디와 이름만으로 만들어진다', () => {
    const { artistId, doc } = normalizeArtist(input);
    assert.equal(artistId, 'artist-lumina');
    assert.deepEqual(doc, { name: { ko: '루미나', en: 'Lumina' } });
  });

  it('선택 필드는 있으면 형식을 본다', () => {
    assert.throws(() => normalizeArtist({ ...input, accentColor: 'green' }));
    assert.throws(() => normalizeArtist({ ...input, initial: ' ' }));
    assert.equal(normalizeArtist({ ...input, initial: 'LM' }).doc.initial, 'LM');
  });

  it('아이디는 형식을 본다', () => {
    assert.throws(() => normalizeArtist({ ...input, artistId: 'a/b' }));
  });
});

describe('normalizePlace', () => {
  const input = { name: { ko: '주문진 방파제', en: 'Jumunjin' }, lat: 37.88, lng: 128.83 };

  it('placeId 가 없으면 새 문서 취급, 반경은 기본값이 채워진다', () => {
    const { placeId, doc } = normalizePlace(input);
    assert.equal(placeId, undefined);
    assert.equal(doc.radiusMeters, 50);
    assert.deepEqual(doc.artistIds, []);
  });

  it('placeId 를 주면 그대로 돌려준다', () => {
    assert.equal(normalizePlace({ ...input, placeId: 'place-jumunjin' }).placeId, 'place-jumunjin');
  });

  it('좌표는 범위를 본다', () => {
    assert.throws(() => normalizePlace({ ...input, lat: 91 }));
    assert.throws(() => normalizePlace({ ...input, lng: -181 }));
  });

  it('artistIds 는 문자열 배열이어야 한다', () => {
    assert.throws(() => normalizePlace({ ...input, artistIds: ['artist-lumina', 1] }));
    assert.deepEqual(normalizePlace({ ...input, artistIds: ['artist-lumina'] }).doc.artistIds, ['artist-lumina']);
  });

  it('radiusMeters 는 양수다', () => {
    assert.throws(() => normalizePlace({ ...input, radiusMeters: 0 }));
    assert.throws(() => normalizePlace({ ...input, radiusMeters: -5 }));
  });
});

describe('containsBanned', () => {
  it('평범한 글은 통과한다', () => {
    assert.equal(containsBanned('주문진 방파제 다녀왔어요. 사진 잘 나왔습니다'), undefined);
    // 공백을 지우고 보기 때문에 이런 문장이 걸리면 안 된다.
    assert.equal(containsBanned('아무것도 보지 못했다'), undefined);
    assert.equal(containsBanned('떡을 씹었다'), undefined);
  });

  it('금칙어를 잡는다', () => {
    assert.equal(containsBanned('아 시발 뭐야'), '시발');
    assert.equal(containsBanned('what the FUCK'), 'fuck');
  });

  it('공백·구두점으로 끊는 회피를 잡는다', () => {
    assert.equal(containsBanned('시 발'), '시발');
    assert.equal(containsBanned('s.h.i.t'), 'shit');
  });
});
