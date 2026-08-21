// 세 콜러블의 실제 동작 — 트랜잭션이 문서에 남기는 결과까지 본다.
//
//   npm --prefix functions run build
//   firebase emulators:exec --only auth,firestore,storage,functions \
//     "node --test functions/test/functions.test.mjs"
//
// logic.test.mjs 가 판정 산수를, 이 파일이 배선을 맡는다.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { initializeTestEnvironment } from '@firebase/rules-unit-testing';
import { initializeApp } from 'firebase/app';
import { connectAuthEmulator, createUserWithEmailAndPassword, getAuth } from 'firebase/auth';
import {
  Timestamp, connectFirestoreEmulator, doc, getDoc, getFirestore, setDoc,
} from 'firebase/firestore';
import { connectFunctionsEmulator, getFunctions, httpsCallable } from 'firebase/functions';
import { connectStorageEmulator, getStorage, ref, uploadBytes } from 'firebase/storage';

const PROJECT = 'pindom-fn-test';
const PLACE = 'jumunjin';
const PLACE2 = 'gyeongpo';
const RAFFLE = 'dream-concert';
// 주문진 방파제.
const HERE = { lat: 37.8947, lng: 128.8305 };
// 쿨다운이 걸리지 않은 두 번째 장소. 첫 장소에서 약 150m — 여기서 더 멀면 직전 티켓 대비
// 속도 검사에 걸려 인증 자체가 통과하지 못한다. 그건 함수가 제대로 도는 것이다.
const THERE = { lat: HERE.lat + 0.00135, lng: HERE.lng };

let seedEnv;
let call;
let db;
let storage;
let uid;

const invoke = async (name, data) => (await httpsCallable(call, name)(data)).data;

const errorCode = async (promise) => {
  try {
    await promise;
    return null;
  } catch (e) {
    return e.details?.errorCode ?? e.code;
  }
};

const reading = (over = {}) => ({
  placeId: PLACE,
  lat: HERE.lat,
  lng: HERE.lng,
  accuracy: 12,
  capturedAt: new Date().toISOString(),
  isMock: false,
  ...over,
});

before(async () => {
  const app = initializeApp({
    apiKey: 'fake', projectId: PROJECT, storageBucket: `${PROJECT}.appspot.com`,
  });
  db = getFirestore(app);
  storage = getStorage(app);
  connectFirestoreEmulator(db, '127.0.0.1', 8080);
  connectStorageEmulator(storage, '127.0.0.1', 9199);
  connectAuthEmulator(getAuth(app), 'http://127.0.0.1:9099', { disableWarnings: true });
  call = getFunctions(app, 'asia-northeast3');
  connectFunctionsEmulator(call, '127.0.0.1', 5001);

  // 시드 데이터는 규칙상 클라이언트가 못 쓴다.
  seedEnv = await initializeTestEnvironment({
    projectId: PROJECT,
    firestore: { host: '127.0.0.1', port: 8080 },
  });
  await seedEnv.withSecurityRulesDisabled(async (ctx) => {
    const seed = ctx.firestore();
    await setDoc(doc(seed, 'places', PLACE), {
      name: { ko: '주문진 방파제', en: 'Jumunjin Breakwater' },
      location: { latitude: HERE.lat, longitude: HERE.lng },
      radiusMeters: 50,
      artistIds: ['artist1'],
    });
    await setDoc(doc(seed, 'places', PLACE2), {
      name: { ko: '주문진 등대', en: 'Jumunjin Lighthouse' },
      location: { latitude: THERE.lat, longitude: THERE.lng },
      radiusMeters: 50,
      artistIds: ['artist1'],
    });
    await setDoc(doc(seed, 'raffles', RAFFLE), {
      title: '드림콘서트', ticketCost: 1, status: 'open',
      closesAt: Timestamp.fromMillis(Date.now() + 86_400_000),
      entryCount: 0,
    });
  });

  const cred = await createUserWithEmailAndPassword(getAuth(app), 'a@example.com', 'pw1234');
  uid = cred.user.uid;
  await setDoc(doc(db, 'users', uid), {
    email: 'a@example.com', nickname: '앨리스',
    ticketBalance: 0, ticketsIssued: 0, placesVisited: 0,
  });
  await uploadBytes(ref(storage, `tickets/${uid}/photo.jpg`), new Uint8Array(8), {
    contentType: 'image/jpeg',
  });
});

after(async () => { await seedEnv.cleanup(); });

describe('verifyLocation', () => {
  it('반경 안이면 통과하고 그랜트를 준다', async () => {
    const res = await invoke('verifyLocation', reading());
    assert.equal(res.verified, true);
    assert.equal(res.requiredRadiusMeters, 50);
    assert.equal(res.grant.token, res.sessionId);
  });

  it('먼 좌표는 거부 — throw 가 아니라 verified: false', async () => {
    const res = await invoke('verifyLocation', reading({ lat: 37.5665, lng: 126.978 }));
    assert.equal(res.verified, false);
    assert.equal(res.reason, 'out_of_radius');
    assert.ok(res.distanceMeters > 100_000);
  });

  it('정확도가 나쁘면 거부하고 세션에 남기지 않는다', async () => {
    const first = await invoke('verifyLocation', reading({ accuracy: 200 }));
    assert.equal(first.reason, 'poor_accuracy');
    const snap = await seedRead(`verificationSessions/${first.sessionId}`);
    assert.equal(snap.readings.length, 0);
  });

  it('mock 위치는 거부', async () => {
    const res = await invoke('verifyLocation', reading({ isMock: true }));
    assert.equal(res.reason, 'mock_location');
  });

  it('없는 장소는 not-found 로 던진다', async () => {
    assert.equal(await errorCode(invoke('verifyLocation', reading({ placeId: 'nope' }))), 'functions/not-found');
  });
});

describe('issueTicket', () => {
  let ticketId;
  let usedGrant;

  it('그랜트를 소비해 티켓을 만들고 카운터를 올린다', async () => {
    const grant = await invoke('verifyLocation', reading());
    const res = await invoke('issueTicket', {
      grantToken: grant.grant.token,
      photoPath: `tickets/${uid}/photo.jpg`,
      visibility: 'public',
    });
    ticketId = res.ticketId;
    usedGrant = grant.grant.token;

    assert.match(res.serial, /^PD-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    assert.equal(res.ticketBalance, 1);
    assert.equal(res.tier, 'club10');

    const ticket = await seedRead(`tickets/${ticketId}`);
    assert.equal(ticket.userId, uid);
    assert.equal(ticket.placeName, '주문진 방파제');
    assert.equal(ticket.spent, false);
    assert.ok(ticket.photoUrl.includes('firebasestorage'));

    const user = await seedRead(`users/${uid}`);
    assert.equal(user.ticketsIssued, 1);
    assert.equal(user.placesVisited, 1);   // 첫 방문
  });

  it('같은 그랜트를 다시 쓰면 grant_consumed — 인증 한 번에 티켓 한 장', async () => {
    assert.ok(usedGrant, '앞 테스트가 먼저 돌아야 한다');
    assert.equal(
      await errorCode(invoke('issueTicket', {
        grantToken: usedGrant, photoPath: `tickets/${uid}/photo.jpg`, visibility: 'private',
      })),
      'grant_consumed',
    );
  });

  it('30일 쿨다운 안이면 cooldown_active 와 다음 가능 날짜', async () => {
    const grant = await invoke('verifyLocation', reading());
    try {
      await invoke('issueTicket', {
        grantToken: grant.grant.token, photoPath: `tickets/${uid}/photo.jpg`, visibility: 'private',
      });
      assert.fail('쿨다운이 걸렸어야 한다');
    } catch (e) {
      assert.equal(e.details.errorCode, 'cooldown_active');
      assert.ok(Date.parse(e.details.nextAvailableAt) > Date.now());
    }
  });

  it('남의 경로에 있는 사진은 거부', async () => {
    // 첫 장소는 이미 쿨다운이라 사진 검사에 닿지 못한다. 두 번째 장소에서 본다.
    const grant = await invoke('verifyLocation',
      reading({ placeId: PLACE2, lat: THERE.lat, lng: THERE.lng }));
    assert.equal(
      await errorCode(invoke('issueTicket', {
        grantToken: grant.grant.token, photoPath: 'tickets/someone/photo.jpg', visibility: 'private',
      })),
      'functions/invalid-argument',
    );
  });
});

describe('enterRaffle', () => {
  it('티켓을 차감하고 응모를 만든다. 같은 키는 두 번 차감하지 않는다', async () => {
    const key = 'entry-key-1';
    const first = await invoke('enterRaffle', { raffleId: RAFFLE, idempotencyKey: key });
    assert.equal(first.ticketBalance, 0);
    assert.equal(first.ticketsSpent, 1);
    assert.equal(first.ticketIds.length, 1);

    const spent = await seedRead(`tickets/${first.ticketIds[0]}`);
    assert.equal(spent.spent, true);
    assert.equal(spent.spentOnEntryId, first.entryId);

    const retry = await invoke('enterRaffle', { raffleId: RAFFLE, idempotencyKey: key });
    assert.equal(retry.entryId, first.entryId);
    assert.equal(retry.ticketBalance, 0);
  });

  it('잔액이 부족하면 insufficient_tickets', async () => {
    assert.equal(
      await errorCode(invoke('enterRaffle', { raffleId: RAFFLE, idempotencyKey: 'entry-key-2' })),
      'insufficient_tickets',
    );
  });

  it('형식이 틀린 키는 invalid-argument', async () => {
    assert.equal(
      await errorCode(invoke('enterRaffle', { raffleId: RAFFLE, idempotencyKey: 'bad/key' })),
      'functions/invalid-argument',
    );
  });
});

/** 규칙이 클라이언트에게 닫아 둔 문서도 읽어야 하므로 규칙 우회 컨텍스트로 읽는다. */
async function seedRead(path) {
  let data;
  await seedEnv.withSecurityRulesDisabled(async (ctx) => {
    const snap = await getDoc(doc(ctx.firestore(), path));
    data = snap.data();
  });
  return data;
}
