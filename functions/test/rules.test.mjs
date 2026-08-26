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
  Timestamp, collection, doc, getDoc, getDocs, query, serverTimestamp, setDoc, updateDoc, where,
} from 'firebase/firestore';
import { deleteObject, listAll, ref, uploadBytes } from 'firebase/storage';

const ALICE = 'alice';
const BOB = 'bob';
// 프로필 수정 테스트 전용. 앨리스의 닉네임을 바꾸면 리뷰·게시글의 작성자 대조가 깨진다.
const CAROL = 'carol';
const PLACE = 'place1';
const BOARD = 'free';
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
    await setDoc(doc(db, 'boards', BOARD), { kind: 'free', name: { ko: '자유게시판', en: 'Free Board' }, order: 0, archived: false });
  });
});

after(async () => { await env.cleanup(); });

const review = (over = {}) => ({
  authorId: ALICE, authorNickname: '앨리스', authorTier: 'club10',
  text: '좋았어요', tags: ['조용함'], likeCount: 0, createdAt: serverTimestamp(), ...over,
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
  it('본인 이름으로 작성 — tier 없는 사용자, 같은 장소에 여러 개도 허용', async () => {
    await assertSucceeds(setDoc(path(alice(), PLACE, 'r1'), review()));
    await assertSucceeds(setDoc(path(alice(), PLACE, 'r2'), review()));
    await assertFails(setDoc(path(alice(), PLACE, 'r0b'), review({ authorTier: 'club20' })));
  });

  it('tier 가 있는 사용자는 그 값과 대조한다', async () => {
    const mine = { authorId: BOB, authorNickname: '밥', authorTier: 'club20',
      text: 't', tags: [], likeCount: 0, createdAt: serverTimestamp() };
    await assertSucceeds(setDoc(path(bob(), PLACE, 'rb1'), mine));
    await assertFails(setDoc(path(bob(), PLACE, 'rb2'), { ...mine, authorTier: 'club10' }));
  });

  it('남의 이름, 등급 위조, likeCount 선점은 거부', async () => {
    await assertFails(setDoc(path(alice(), PLACE, 'r3'), review({ authorId: BOB })));
    await assertFails(setDoc(path(alice(), PLACE, 'r4'), review({ authorNickname: '밥' })));
    await assertFails(setDoc(path(alice(), PLACE, 'r5'), review({ authorTier: 'clubGo' })));
    await assertFails(setDoc(path(alice(), PLACE, 'r6'), review({ likeCount: 50 })));
    // 미래 시각으로 목록 상단을 점유하는 것을 막는다.
    await assertFails(setDoc(path(alice(), PLACE, 'r7'),
      review({ createdAt: Timestamp.fromMillis(4102444800000) })));
  });

  it('수정은 본문과 태그만, 삭제는 본인만', async () => {
    await assertSucceeds(updateDoc(path(alice(), PLACE, 'r1'), { text: '고침', tags: ['a'] }));
    await assertFails(updateDoc(path(alice(), PLACE, 'r1'), { likeCount: 9 }));
    await assertFails(updateDoc(path(bob(), PLACE, 'r1'), { text: '탈취' }));
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

  it('verificationSessions 는 클라이언트에게 완전히 닫혀 있음', async () => {
    await assertFails(getDoc(doc(alice(), 'verificationSessions', 's1')));
    await assertFails(setDoc(doc(alice(), 'verificationSessions', 's1'), { userId: ALICE }));
  });

  it('갤러리와 시드 컬렉션은 쓰기 불가', async () => {
    await assertFails(setDoc(doc(alice(), 'places', PLACE, 'gallery', 'g1'), { authorId: ALICE }));
    await assertFails(setDoc(doc(alice(), 'places', PLACE), { name: '가짜' }));
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
