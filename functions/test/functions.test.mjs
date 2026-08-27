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
import { deleteApp, initializeApp } from 'firebase/app';
import { connectAuthEmulator, createUserWithEmailAndPassword, getAuth } from 'firebase/auth';
import {
  Timestamp, collection, connectFirestoreEmulator, doc, getDoc, getFirestore, setDoc,
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
let clientApp;
let call;
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
  const db = getFirestore(app);
  const storage = getStorage(app);
  connectFirestoreEmulator(db, '127.0.0.1', 8080);
  connectStorageEmulator(storage, '127.0.0.1', 9199);
  connectAuthEmulator(getAuth(app), 'http://127.0.0.1:9099', { disableWarnings: true });
  clientApp = app;
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

// 클라이언트 앱을 닫지 않으면 열린 연결이 남아 node --test 가 영영 종료되지 않는다.
after(async () => { await seedEnv.cleanup(); await deleteApp(clientApp); });

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

  it('과거 시각을 보내면 거부 — 속도 검사의 분모를 조작할 수 없다', async () => {
    const anHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    assert.equal(
      await errorCode(invoke('verifyLocation', reading({ capturedAt: anHourAgo }))),
      'functions/invalid-argument',
    );
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

// 도착 검사(직전 티켓 대비 300km/h)는 세션당 한 번만 돈다. 그 "한 번" 을 거부 응답으로
// 소모시킬 수 있으면 게이트가 통째로 무력해진다. 티켓이 있어야 성립해서 맨 뒤에 둔다.
//
// 우선순위는 accuracy → radius → 세션 내 이동속도 → 도착 검사 순이다. 도착 검사가 먼저
// 돌면 부정확하거나 반경 밖인 평범한 상황까지 "위치 조작이 의심된다" 로 답하게 되고,
// accuracy 거부가 나야 할 표본이 implausible_speed(append: true) 로 readings 에 남아
// 다음 속도 계산을 오염시킨다.
describe('도착 검사', () => {
  const FAR = 'seoul-far';
  // 주문진에서 약 160km. 방금 여기서 티켓을 받았다면 무엇이든 시속 9,000km 다.
  const SEOUL = { lat: 37.5665, lng: 126.978 };

  before(async () => {
    await seedEnv.withSecurityRulesDisabled(async (ctx) => {
      const seed = ctx.firestore();
      await setDoc(doc(seed, 'places', FAR), {
        name: { ko: '서울' },
        location: { latitude: SEOUL.lat, longitude: SEOUL.lng },
        radiusMeters: 50,
      });
      // jumpedFromLastTicket 은 이 uid 의 issuedAt 내림차순 최신 티켓과 비교한다.
      // 앞선 describe(issueTicket)가 이미 이 uid 로 티켓을 하나 만들어 뒀으니, 이 티켓이
      // 그보다 나중임을 보장해야 한다 — 과거로 되돌려 찍으면(예: -60초) 먼저 만들어진
      // 티켓보다 더 오래된 것으로 밀려 비교 대상에서 빠진다.
      await setDoc(doc(seed, 'tickets', 'far-ticket'), {
        userId: uid, placeId: FAR, placeName: '서울', photoUrl: 'x',
        serial: 'PD-TEST-TEST-TEST', visibility: 'private', spent: false,
        issuedAt: Timestamp.now(),
      });
    });
  });

  it('반경 밖이면서 이동속도도 불가능하면 out_of_radius 가 이긴다', async () => {
    const res = await invoke('verifyLocation', reading({ accuracy: 30, lat: 38.5, lng: 128.5 }));
    assert.equal(res.verified, false);
    assert.equal(res.reason, 'out_of_radius');
  });

  it('정확도도 나쁘고 이동속도도 불가능하면 poor_accuracy 가 이기고, 세션에 남지 않는다', async () => {
    const res = await invoke('verifyLocation', reading({ accuracy: 9999, lat: 38.5, lng: 128.5 }));
    assert.equal(res.verified, false);
    assert.equal(res.reason, 'poor_accuracy');
    const snap = await seedRead(`verificationSessions/${res.sessionId}`);
    assert.equal(snap.readings.length, 0);
  });

  it('accuracy·radius 를 통과하면 그제서야 도착 검사가 거부한다', async () => {
    // 정확도 좋고 반경 안 — 다른 게이트는 전부 통과다. 그런데도 여전히 거부돼야
    // 도착 검사가 죽은 게 아니라 우선순위만 뒤로 밀렸다는 것이 증명된다.
    const res = await invoke('verifyLocation', reading());
    assert.equal(res.verified, false);
    assert.equal(res.reason, 'implausible_speed');
  });

  it('poor_accuracy 로 거부된 호출은 도착 검사를 소모하지 않는다', async () => {
    // accuracy·radius·세션 내 속도 검사에서 먼저 거부된 호출은 도착 검사 결과를 쓰지도
    // 않았으므로 세션에도 "체크됨" 을 남기면 안 된다 — 아니면 accuracy 를 일부러 나쁘게
    // 보내 "체크됨" 도장만 받고 다음 호출에서 진짜 좌표로 도착 검사를 피해 갈 수 있다.
    const first = await invoke('verifyLocation', reading({ accuracy: 9999, lat: 38.5, lng: 128.5 }));
    assert.equal(first.reason, 'poor_accuracy');
    const second = await invoke('verifyLocation', reading({ sessionId: first.sessionId }));
    // 두 번째 핑은 accuracy·radius·세션 내 속도를 전부 통과하지만, 도착 검사가 이제야
    // 처음으로 돈다 — 여전히 거부돼야 한다.
    assert.equal(second.verified, false);
    assert.equal(second.reason, 'implausible_speed');
  });

  it('도착 검사가 실제로 판정을 내린 뒤에는 같은 세션에서 다시 돌지 않는다', async () => {
    const first = await invoke('verifyLocation', reading());
    assert.equal(first.reason, 'implausible_speed');
    const second = await invoke('verifyLocation', reading({ sessionId: first.sessionId }));
    // 첫 호출에서 도착 검사가 실제로 거부를 결정했으니 여기서는 소모된 게 맞다.
    assert.equal(second.verified, true);
  });
});


// 별도 사용자로 돈다 — 공유 uid 로 지우면 그 uid 를 계속 쓰는 다른 describe 가 깨진다.
// 이 describe 가 끝나면 클라이언트의 로그인 사용자가 이 사람으로 남는데, 뒤의 saveBoard
// 는 uid 를 안 보고 admin 클레임 유무만 보므로 상관없다.
describe('deleteAccount', () => {
  it('본인 데이터를 지우고, 본인이 넣은 신고는 지우지 않고 신원만 지운다', async () => {
    const db = getFirestore(clientApp);
    const storage = getStorage(clientApp);
    const auth = getAuth(clientApp);

    const cred = await createUserWithEmailAndPassword(auth, 'bob-del@example.com', 'pw1234');
    const delUid = cred.user.uid;
    await setDoc(doc(db, 'users', delUid), {
      email: 'bob-del@example.com', nickname: '밥',
      ticketBalance: 0, ticketsIssued: 0, placesVisited: 0,
    });
    await uploadBytes(ref(storage, `tickets/${delUid}/photo.jpg`), new Uint8Array(8), {
      contentType: 'image/jpeg',
    });

    // 티켓·리뷰·신고는 규칙상 클라이언트가 직접 못 써서 시드로 넣는다.
    let ticketId, reviewId, reportId;
    await seedEnv.withSecurityRulesDisabled(async (ctx) => {
      const seed = ctx.firestore();
      const ticketRef = doc(collection(seed, 'tickets'));
      ticketId = ticketRef.id;
      await setDoc(ticketRef, {
        userId: delUid, placeId: PLACE, placeName: '주문진 방파제',
        photoPath: `tickets/${delUid}/photo.jpg`, photoUrl: 'x', serial: 'PD-DEL0-DEL0-DEL0',
        visibility: 'private', spent: false, issuedAt: Timestamp.now(),
      });
      const reviewRef = doc(collection(seed, `places/${PLACE}/reviews`));
      reviewId = reviewRef.id;
      await setDoc(reviewRef, {
        authorId: delUid, authorNickname: '밥', authorTier: 'club10',
        text: '좋았다', likeCount: 0, createdAt: Timestamp.now(),
      });
      const reportRef = doc(collection(seed, 'reports'));
      reportId = reportRef.id;
      await setDoc(reportRef, {
        reporterId: delUid, targetType: 'post', targetId: 'p1',
        reason: '욕설', createdAt: Timestamp.now(),
      });
    });

    await invoke('deleteAccount', {});

    assert.equal(await seedRead(`users/${delUid}`), undefined);
    assert.equal(await seedRead(`tickets/${ticketId}`), undefined);
    assert.equal(await seedRead(`places/${PLACE}/reviews/${reviewId}`), undefined);

    // 신고는 지워지지 않고 남되, 신원만 익명화된다 — 다른 사용자에 대한 모더레이션
    // 근거를 계정 삭제로 함께 지울 수 없어야 한다.
    const report = await seedRead(`reports/${reportId}`);
    assert.notEqual(report, undefined);
    assert.equal(report.reporterId, 'deleted');

    // Auth 계정이 실제로 지워졌다면 같은 이메일로 다시 가입할 수 있어야 한다.
    await assert.doesNotReject(
      createUserWithEmailAndPassword(auth, 'bob-del@example.com', 'pw5678'),
    );
  });
});

// saveBoard 의 방어선은 admin 커스텀 클레임 하나다. 입력 검증은 normalizeBoard 가 맡고
// logic.test.mjs 가 경계를 찍는다. 여기서 볼 것은 클레임 없는 계정이 막히는가뿐이다.
describe('saveBoard', () => {
  it('admin 클레임이 없으면 permission-denied', async () => {
    const code = await errorCode(
      invoke('saveBoard', {
        boardId: 'artist-lumina',
        kind: 'artist',
        name: { ko: '루미나', en: 'Lumina' },
      }),
    );
    assert.equal(code, 'functions/permission-denied');
  });
});
