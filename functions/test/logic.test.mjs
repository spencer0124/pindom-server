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
