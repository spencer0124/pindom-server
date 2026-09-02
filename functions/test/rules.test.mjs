// firestore.rules · storage.rules 단위 테스트.
//
//   npm --prefix functions i
//   firebase emulators:exec --only firestore,storage "node --test functions/test/rules.test.mjs"
//
// 케이스는 규칙이 실제로 깨질 지점만 담는다. 통과하는 경로를 전부 나열하지 않는다.

import { after, before, describe, it } from 'node:test';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
} from '@firebase/rules-unit-testing';
import { readFileSync } from 'node:fs';
import {
  Timestamp, collection, deleteDoc, doc, getDoc, getDocs, query, serverTimestamp, setDoc, updateDoc, where,
} from 'firebase/firestore';
import { deleteObject, listAll, ref, uploadBytes } from 'firebase/storage';

const ALICE = 'alice';
const BOB = 'bob';
// 프로필 수정 테스트 전용. 앨리스의 닉네임을 바꾸면 리뷰·게시글의 작성자 대조가 깨진다.
const CAROL = 'carol';
const PLACE = 'place1';
const BOARD = 'board-free';
const OTHER_PLACE = 'place2';

let env;

const alice = () => env.authenticatedContext(ALICE).firestore();
const bob = () => env.authenticatedContext(BOB).firestore();
const carol = () => env.authenticatedContext(CAROL).firestore();

before(async () => {
  env = await initializeTestEnvironment({
    projectId: 'pindom-rules-test',
    firestore: { rules: readFileSync('firestore.rules', 'utf8'), host: '127.0.0.1', port: 8080 },
    storage: { rules: readFileSync('storage.rules', 'utf8'), host: '127.0.0.1', port: 9199 },
  });

  // 규칙을 우회해 기반 데이터를 심는다.
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    // 앱의 signUp 이 쓰는 그대로. tier 는 없다 — issueTicket 이 첫 티켓에서 만든다.
    await setDoc(doc(db, 'users', ALICE), {
      email: 'alice@example.com', nickname: '앨리스',
      ticketBalance: 3, ticketsIssued: 3, placesVisited: 2,
    });
    // 티켓을 쌓아 tier 가 생긴 사용자.
    await setDoc(doc(db, 'users', BOB), {
      email: 'bob@example.com', nickname: '밥', tier: 'club20',
      ticketBalance: 0, ticketsIssued: 22, placesVisited: 9,
    });
    await setDoc(doc(db, 'users', CAROL), {
      email: 'carol@example.com', nickname: '캐롤',
      ticketBalance: 0, ticketsIssued: 0, placesVisited: 0,
    });
    await setDoc(doc(db, 'tickets', 'tA1'), { userId: ALICE, placeId: PLACE, visibility: 'private', serial: 'PD-1' });
    await setDoc(doc(db, 'tickets', 'tA2'), { userId: ALICE, placeId: PLACE, visibility: 'public', serial: 'PD-2' });
    await setDoc(doc(db, 'tickets', 'tA3'), { userId: ALICE, placeId: OTHER_PLACE, visibility: 'private', serial: 'PD-3' });
    await setDoc(doc(db, 'tickets', 'tB1'), { userId: BOB, placeId: PLACE, visibility: 'private', serial: 'PD-4' });
    // 리뷰 문서 id 는 ticketId 다 — 케이스마다 다른 티켓이 필요하다. 같은 id 에 두 번 쓰면
    // 두 번째는 create 가 아니라 update 로 심사되어 검증하려던 조건을 지나쳐 버린다.
    for (const n of [4, 5, 6, 7, 8, 9]) {
      await setDoc(doc(db, 'tickets', `tA${n}`), { userId: ALICE, placeId: PLACE, visibility: 'private', serial: `PD-A${n}` });
    }
    await setDoc(doc(db, 'tickets', 'tB2'), { userId: BOB, placeId: PLACE, visibility: 'private', serial: 'PD-5' });
    await setDoc(doc(db, 'tickets', 'tB3'), { userId: BOB, placeId: PLACE, visibility: 'private', serial: 'PD-6' });
    await setDoc(doc(db, 'boards', BOARD), { kind: 'free', name: { ko: '자유게시판', en: 'Free Board' }, order: 0, archived: false });
  });
});

after(async () => { await env.cleanup(); });

// ticketId 는 문서 id 와 같아야 한다 — 규칙이 그 티켓을 읽어 소유자와 장소를 확인한다.
const review = (ticketId, over = {}) => ({
  authorId: ALICE, authorNickname: '앨리스', authorTier: 'club10',
  text: '좋았어요', tags: ['조용함'], likeCount: 0, ticketId, createdAt: serverTimestamp(), ...over,
});

describe('users', () => {
  it('본인 문서 생성 — 카운터 0이면 통과, 하나라도 0이 아니면 거부', async () => {
    const base = { email: 'd@example.com', nickname: '신규', ticketBalance: 0, ticketsIssued: 0, placesVisited: 0 };
    const dave = env.authenticatedContext('dave').firestore();
    await assertFails(setDoc(doc(dave, 'users', 'dave'), { ...base, ticketBalance: 10 }));
    // tier 는 함수 전용이다. 가입 요청에 끼워 넣으면 이후 배지 대조가 위조된 값으로 통과한다.
    await assertFails(setDoc(doc(dave, 'users', 'dave'), { ...base, tier: 'clubGo' }));
    await assertSucceeds(setDoc(doc(dave, 'users', 'dave'), base));
  });

  it('편집 가능한 여섯 필드는 통과', async () => {
    await assertSucceeds(updateDoc(doc(carol(), 'users', CAROL), {
      nickname: 'A', avatarUrl: 'u', bio: 'b', followedArtistIds: ['x'],
      profileVisibility: 'private', locale: 'en',
    }));
  });

  it('tier 와 카운터는 거부', async () => {
    await assertFails(updateDoc(doc(carol(), 'users', CAROL), { tier: 'clubGo' }));
    await assertFails(updateDoc(doc(carol(), 'users', CAROL), { ticketBalance: 999 }));
    await assertFails(updateDoc(doc(carol(), 'users', CAROL), { nickname: 'A', ticketsIssued: 99 }));
  });

  it('타인 문서는 읽지도 쓰지도 못함', async () => {
    await assertFails(getDoc(doc(bob(), 'users', ALICE)));
    await assertFails(updateDoc(doc(bob(), 'users', ALICE), { nickname: '탈취' }));
  });
});

describe('savedPlaces', () => {
  const path = (db, uid, id) => doc(db, 'users', uid, 'savedPlaces', id);
  const saved = (over = {}) => ({
    name: '해운대', category: '해변', address: '', lat: 35.16, lng: 129.16,
    source: 'kakao', sourceId: 'kakao_1', savedAt: serverTimestamp(), ...over,
  });

  it('본인 것만 담고, 지운다', async () => {
    await assertSucceeds(setDoc(path(alice(), ALICE, 'kakao_1'), saved()));
    await assertFails(setDoc(path(bob(), ALICE, 'kakao_2'), saved({ sourceId: 'kakao_2' })));
    await assertSucceeds(getDoc(path(alice(), ALICE, 'kakao_1')));
    await assertFails(getDoc(path(bob(), ALICE, 'kakao_1')));
    await assertSucceeds(deleteDoc(path(alice(), ALICE, 'kakao_1')));
  });

  it('좌표가 이상하면 거부 — 지도 핀이 깨진다', async () => {
    await assertFails(setDoc(path(alice(), ALICE, 'bad1'), saved({ lat: '35.16' })));
    await assertFails(setDoc(path(alice(), ALICE, 'bad2'), saved({ lat: 200 })));
    await assertFails(setDoc(path(alice(), ALICE, 'bad3'), saved({ name: '' })));
  });

  it('수정은 없음 — 지우고 다시 담아야 한다', async () => {
    await setDoc(path(alice(), ALICE, 'kakao_3'), saved({ sourceId: 'kakao_3' }));
    await assertFails(updateDoc(path(alice(), ALICE, 'kakao_3'), { name: '고침' }));
  });
});

describe('tickets', () => {
  it('목록 조회는 userId == uid 가 쿼리에 있을 때만', async () => {
    const db = alice();
    await assertSucceeds(getDocs(query(collection(db, 'tickets'), where('userId', '==', ALICE))));
    await assertFails(getDocs(collection(db, 'tickets')));
    await assertFails(getDocs(query(collection(db, 'tickets'), where('userId', '==', BOB))));
  });

  it('문서 하나 읽기는 본인 것 또는 공개 티켓', async () => {
    await assertSucceeds(getDoc(doc(bob(), 'tickets', 'tA2')));   // public
    await assertFails(getDoc(doc(bob(), 'tickets', 'tA1')));      // private
  });

  it('본인 티켓의 visibility 만 수정 가능', async () => {
    await assertSucceeds(updateDoc(doc(alice(), 'tickets', 'tA1'), { visibility: 'public' }));
    await assertFails(updateDoc(doc(alice(), 'tickets', 'tA1'), { serial: 'PD-FAKE' }));
    await assertFails(updateDoc(doc(alice(), 'tickets', 'tA1'), { visibility: 'x' }));
    await assertFails(updateDoc(doc(bob(), 'tickets', 'tA1'), { visibility: 'private' }));
  });
});

describe('reviews', () => {
  const path = (db, placeId, id) => doc(db, 'places', placeId, 'reviews', id);

  // 앨리스에게는 tier 필드가 없다 — 앱의 signUp 이 쓰지 않기 때문이다.
  // 규칙이 기본값 club10 으로 읽어야 이 통과가 성립한다.
  it('본인 이름으로 작성 — tier 없는 사용자, 티켓 한 장에 팁 하나', async () => {
    await assertSucceeds(setDoc(path(alice(), PLACE, 'tA1'), review('tA1')));
    await assertSucceeds(setDoc(path(alice(), PLACE, 'tA2'), review('tA2')));
    await assertFails(setDoc(path(alice(), PLACE, 'tA4'), review('tA4', { authorTier: 'club20' })));
  });

  it('tier 가 있는 사용자는 그 값과 대조한다', async () => {
    const mine = (ticketId, tier) => ({ authorId: BOB, authorNickname: '밥', authorTier: tier,
      text: 't', tags: [], likeCount: 0, ticketId, createdAt: serverTimestamp() });
    await assertSucceeds(setDoc(path(bob(), PLACE, 'tB1'), mine('tB1', 'club20')));
    await assertFails(setDoc(path(bob(), PLACE, 'tB2'), mine('tB2', 'club10')));
  });

  it('남의 이름, 등급 위조, likeCount 선점은 거부', async () => {
    await assertFails(setDoc(path(alice(), PLACE, 'tA5'), review('tA5', { authorId: BOB })));
    await assertFails(setDoc(path(alice(), PLACE, 'tA6'), review('tA6', { authorNickname: '밥' })));
    await assertFails(setDoc(path(alice(), PLACE, 'tA7'), review('tA7', { authorTier: 'clubGo' })));
    await assertFails(setDoc(path(alice(), PLACE, 'tA8'), review('tA8', { likeCount: 50 })));
    // 미래 시각으로 목록 상단을 점유하는 것을 막는다.
    await assertFails(setDoc(path(alice(), PLACE, 'tA9'),
      review('tA9', { createdAt: Timestamp.fromMillis(4102444800000) })));
  });

  // 가본 적 없는 곳에는 팁을 못 남긴다. 증거는 문서 id 로 쓴 ticketId 하나뿐이라,
  // 규칙이 그 티켓을 읽어 주인과 장소를 둘 다 대조해야 성립한다.
  it('내 티켓이 아니거나, 다른 장소의 티켓이거나, 없는 티켓이면 거부', async () => {
    await assertFails(setDoc(path(alice(), PLACE, 'tB3'), review('tB3')));            // 밥의 티켓
    await assertFails(setDoc(path(alice(), PLACE, 'tA3'), review('tA3')));            // 다른 장소의 티켓
    await assertFails(setDoc(path(alice(), OTHER_PLACE, 'tA3'), review('tA1')));      // 필드가 id 와 다름
    await assertFails(setDoc(path(alice(), PLACE, 'tNope'), review('tNope')));        // 없는 티켓
  });

  it('수정은 본문과 태그만, 삭제는 본인만', async () => {
    await assertSucceeds(updateDoc(path(alice(), PLACE, 'tA1'), { text: '고침', tags: ['a'] }));
    await assertFails(updateDoc(path(alice(), PLACE, 'tA1'), { likeCount: 9 }));
    await assertFails(updateDoc(path(bob(), PLACE, 'tA1'), { text: '탈취' }));
  });
});

describe('나머지', () => {
  const post = (over = {}) => ({
    boardId: BOARD, authorId: ALICE, authorNickname: '앨리스', authorTier: 'club10',
    body: 'hi', imageUrls: [], likeCount: 0, commentCount: 0,
    createdAt: serverTimestamp(), ...over,
  });

  it('posts — 카운트 선점, 남의 이름, 등급 위조 모두 거부', async () => {
    const db = alice();
    await assertSucceeds(setDoc(doc(db, 'posts', 'p1'), post()));
    await assertFails(setDoc(doc(db, 'posts', 'p2'), post({ likeCount: 5 })));
    await assertFails(setDoc(doc(db, 'posts', 'p3'), post({ authorId: BOB })));
    await assertFails(setDoc(doc(db, 'posts', 'p4'), post({ authorNickname: '밥' })));
    await assertFails(setDoc(doc(db, 'posts', 'p5'), post({ authorTier: 'clubGo' })));
    await assertFails(setDoc(doc(db, 'posts', 'p6'),
      post({ createdAt: Timestamp.fromMillis(4102444800000) })));
    await assertSucceeds(setDoc(doc(db, 'posts', 'p7-legacy'), post({ boardId: 'board-free' })));
    // 없는 게시판에 쓴 글은 어느 피드 쿼리에도 안 잡힌다 — 컬렉션에만 남는 유령이 된다.
    await assertFails(setDoc(doc(db, 'posts', 'p8'), post({ boardId: 'no-such-board' })));
  });

  it('boards — 읽기는 로그인만, 쓰기는 saveBoard 전용', async () => {
    await assertSucceeds(getDoc(doc(alice(), 'boards', BOARD)));
    await assertFails(setDoc(doc(alice(), 'boards', 'my-own-board'),
      { kind: 'artist', name: { ko: '내 게시판', en: 'Mine' }, order: 0, archived: false }));
    await assertFails(updateDoc(doc(alice(), 'boards', BOARD), { order: -1 }));
  });

  it('사용자 문서가 없는 계정은 글을 쓸 수 없다', async () => {
    const eve = env.authenticatedContext('eve').firestore();
    await assertFails(setDoc(doc(eve, 'posts', 'p7'), post({ authorId: 'eve', authorNickname: '이브' })));
  });

  it('본문·이미지 개수에 상한이 있다', async () => {
    await assertFails(setDoc(doc(alice(), 'posts', 'p8'), post({ body: 'x'.repeat(5001) })));
    await assertFails(setDoc(doc(alice(), 'posts', 'p9'), post({ imageUrls: Array(10).fill('u') })));
    await assertSucceeds(setDoc(doc(alice(), 'posts', 'p10'), post({ imageUrls: Array(9).fill('u') })));
  });

  it('update 로 상한을 우회할 수 없다', async () => {
    await setDoc(doc(alice(), 'posts', 'p11'), post());
    await assertFails(updateDoc(doc(alice(), 'posts', 'p11'), { body: 'x'.repeat(5001) }));
  });

  it('verificationSessions 는 클라이언트에게 완전히 닫혀 있음', async () => {
    await assertFails(getDoc(doc(alice(), 'verificationSessions', 's1')));
    await assertFails(setDoc(doc(alice(), 'verificationSessions', 's1'), { userId: ALICE }));
  });

  it('갤러리와 시드 컬렉션은 쓰기 불가', async () => {
    await assertFails(setDoc(doc(alice(), 'places', PLACE, 'gallery', 'g1'), { authorId: ALICE }));
    await assertFails(setDoc(doc(alice(), 'places', PLACE), { name: '가짜' }));
  });
});

describe('reports · 차단 (Apple 1.2)', () => {
  const report = (over = {}) => ({
    reporterId: ALICE, targetType: 'post', targetId: 'p1',
    reason: '욕설', createdAt: serverTimestamp(), ...over,
  });

  it('본인 이름으로만 신고할 수 있다', async () => {
    await assertSucceeds(setDoc(doc(alice(), 'reports', 'r1'), report()));
    await assertFails(setDoc(doc(alice(), 'reports', 'r2'), report({ reporterId: BOB })));
  });

  it('targetType 은 정해진 값만', async () => {
    await assertFails(setDoc(doc(alice(), 'reports', 'r3'), report({ targetType: '아무거나' })));
  });

  it('createdAt 은 서버 시각이어야 한다 — 클라이언트 시각은 거부', async () => {
    await assertFails(setDoc(doc(alice(), 'reports', 'r4'), report({ createdAt: Timestamp.now() })));
  });

  it('넣기만 하는 상자다 — 본인 신고도 못 읽고 못 지운다', async () => {
    await assertFails(getDoc(doc(alice(), 'reports', 'r1')));
    await assertFails(deleteDoc(doc(alice(), 'reports', 'r1')));
  });

  it('닉네임·소개는 길이 상한 안에서만', async () => {
    await assertFails(updateDoc(doc(carol(), 'users', CAROL), { nickname: 'x'.repeat(31) }));
    await assertFails(updateDoc(doc(carol(), 'users', CAROL), { bio: 'x'.repeat(501) }));
    await assertSucceeds(updateDoc(doc(carol(), 'users', CAROL), { bio: 'x'.repeat(500) }));
  });

  it('신고에 없는 필드를 끼워 넣을 수 없다', async () => {
    await assertFails(setDoc(doc(alice(), 'reports', 'rX'), {
      reporterId: ALICE, targetType: 'post', targetId: 'p1',
      reason: '욕설', createdAt: serverTimestamp(), extra: 'hi',
    }));
  });

  it('blockedUserIds 는 본인이 고칠 수 있다', async () => {
    await assertSucceeds(updateDoc(doc(carol(), 'users', CAROL), { blockedUserIds: [BOB] }));
    await assertFails(updateDoc(doc(carol(), 'users', ALICE), { blockedUserIds: [BOB] }));
  });

  it('차단 목록에 상한이 있다', async () => {
    const huge = Array.from({ length: 1001 }, (_, i) => `u${i}`);
    await assertFails(updateDoc(doc(carol(), 'users', CAROL), { blockedUserIds: huge }));
  });

  it('차단을 끼워 넣어도 카운터는 못 건드린다', async () => {
    await assertFails(updateDoc(doc(carol(), 'users', CAROL), {
      blockedUserIds: [BOB], ticketBalance: 99,
    }));
  });

  it('rateLimits 는 본인 것도 못 읽고 못 쓴다 — 남은 횟수가 새거나 상한이 무의미해진다', async () => {
    await assertFails(getDoc(doc(alice(), 'rateLimits', ALICE)));
    await assertFails(setDoc(doc(alice(), 'rateLimits', ALICE), { assistantCount: 0 }));
  });
});

describe('storage', () => {
  it('본인 경로의 이미지만, 크기 상한 안에서 업로드 가능', async () => {
    const bytes = new Uint8Array(8);
    const mine = env.authenticatedContext(ALICE).storage();
    await assertSucceeds(uploadBytes(ref(mine, `tickets/${ALICE}/a.jpg`), bytes, { contentType: 'image/jpeg' }));
    await assertFails(uploadBytes(ref(mine, `tickets/${BOB}/a.jpg`), bytes, { contentType: 'image/jpeg' }));
    await assertFails(uploadBytes(ref(mine, `tickets/${ALICE}/a.txt`), bytes, { contentType: 'text/plain' }));
    await assertFails(uploadBytes(ref(mine, `secrets/${ALICE}/a.jpg`), bytes, { contentType: 'image/jpeg' }));
  });

  it('본인 파일은 지울 수 있고 남의 파일은 못 지운다', async () => {
    const bytes = new Uint8Array(8);
    const mine = env.authenticatedContext(ALICE).storage();
    await env.withSecurityRulesDisabled(async (ctx) => {
      await uploadBytes(ref(ctx.storage(), `posts/${BOB}/b.jpg`), bytes, { contentType: 'image/jpeg' });
    });
    await assertSucceeds(uploadBytes(ref(mine, `posts/${ALICE}/a.jpg`), bytes, { contentType: 'image/jpeg' }));
    await assertSucceeds(deleteObject(ref(mine, `posts/${ALICE}/a.jpg`)));
    await assertFails(deleteObject(ref(mine, `posts/${BOB}/b.jpg`)));
  });

  it('남의 폴더를 훑을 수 없음 — list 는 닫혀 있다', async () => {
    const mine = env.authenticatedContext(ALICE).storage();
    await assertFails(listAll(ref(mine, `tickets/${BOB}`)));
    await assertFails(listAll(ref(mine, `tickets/${ALICE}`)));
  });
});
