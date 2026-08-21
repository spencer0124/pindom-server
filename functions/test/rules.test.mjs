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
import { doc, getDoc, getDocs, query, setDoc, updateDoc, where, collection } from 'firebase/firestore';
import { listAll, ref, uploadBytes } from 'firebase/storage';

const ALICE = 'alice';
const BOB = 'bob';
// 프로필 수정 테스트 전용. 앨리스의 닉네임을 바꾸면 리뷰·게시글의 작성자 대조가 깨진다.
const CAROL = 'carol';
const PLACE = 'place1';
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
    await setDoc(doc(db, 'users', ALICE), {
      email: 'alice@example.com', nickname: '앨리스', tier: 'club10',
      ticketBalance: 3, ticketsIssued: 3, placesVisited: 2,
    });
    await setDoc(doc(db, 'users', BOB), {
      email: 'bob@example.com', nickname: '밥', tier: 'club10',
      ticketBalance: 0, ticketsIssued: 0, placesVisited: 0,
    });
    await setDoc(doc(db, 'users', CAROL), {
      email: 'carol@example.com', nickname: '캐롤', tier: 'club10',
      ticketBalance: 0, ticketsIssued: 0, placesVisited: 0,
    });
    await setDoc(doc(db, 'tickets', 'tA1'), { userId: ALICE, placeId: PLACE, visibility: 'private', serial: 'PD-1' });
    await setDoc(doc(db, 'tickets', 'tA2'), { userId: ALICE, placeId: PLACE, visibility: 'public', serial: 'PD-2' });
    await setDoc(doc(db, 'tickets', 'tA3'), { userId: ALICE, placeId: OTHER_PLACE, visibility: 'private', serial: 'PD-3' });
    await setDoc(doc(db, 'tickets', 'tB1'), { userId: BOB, placeId: PLACE, visibility: 'private', serial: 'PD-4' });
  });
});

after(async () => { await env.cleanup(); });

const review = (over = {}) => ({
  authorId: ALICE, authorNickname: '앨리스', authorTier: 'club10',
  text: '좋았어요', tags: ['조용함'], likeCount: 0, ...over,
});

// 리뷰는 방문을 검증하지 않는다 — 규칙이 컬렉션을 조회할 수 없어서다.
// 앱이 리뷰 id 를 ticketId 로 쓰기 시작하면 그때 티켓 소유 검사를 추가한다.

describe('users', () => {
  it('본인 문서 생성 — 카운터 0이면 통과, 하나라도 0이 아니면 거부', async () => {
    const base = { email: 'd@example.com', nickname: '신규', ticketBalance: 0, ticketsIssued: 0, placesVisited: 0 };
    const dave = env.authenticatedContext('dave').firestore();
    await assertFails(setDoc(doc(dave, 'users', 'dave'), { ...base, ticketBalance: 10 }));
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
    await assertFails(updateDoc(doc(bob(), 'tickets', 'tA1'), { visibility: 'private' }));
  });
});

describe('reviews', () => {
  const path = (db, placeId, id) => doc(db, 'places', placeId, 'reviews', id);

  it('본인 이름으로 작성 — 같은 장소에 여러 개도 허용', async () => {
    await assertSucceeds(setDoc(path(alice(), PLACE, 'r1'), review()));
    await assertSucceeds(setDoc(path(alice(), PLACE, 'r2'), review()));
  });

  it('남의 이름, 등급 위조, likeCount 선점은 거부', async () => {
    await assertFails(setDoc(path(alice(), PLACE, 'r3'), review({ authorId: BOB })));
    await assertFails(setDoc(path(alice(), PLACE, 'r4'), review({ authorNickname: '밥' })));
    await assertFails(setDoc(path(alice(), PLACE, 'r5'), review({ authorTier: 'clubGo' })));
    await assertFails(setDoc(path(alice(), PLACE, 'r6'), review({ likeCount: 50 })));
  });

  it('수정은 본문과 태그만, 삭제는 본인만', async () => {
    await assertSucceeds(updateDoc(path(alice(), PLACE, 'r1'), { text: '고침', tags: ['a'] }));
    await assertFails(updateDoc(path(alice(), PLACE, 'r1'), { likeCount: 9 }));
    await assertFails(updateDoc(path(bob(), PLACE, 'r1'), { text: '탈취' }));
  });
});

describe('나머지', () => {
  const post = (over = {}) => ({
    boardId: 'b1', authorId: ALICE, authorNickname: '앨리스', authorTier: 'club10',
    body: 'hi', imageUrls: [], likeCount: 0, commentCount: 0, ...over,
  });

  it('posts — 카운트 선점, 남의 이름, 등급 위조 모두 거부', async () => {
    const db = alice();
    await assertSucceeds(setDoc(doc(db, 'posts', 'p1'), post()));
    await assertFails(setDoc(doc(db, 'posts', 'p2'), post({ likeCount: 5 })));
    await assertFails(setDoc(doc(db, 'posts', 'p3'), post({ authorId: BOB })));
    await assertFails(setDoc(doc(db, 'posts', 'p4'), post({ authorNickname: '밥' })));
    await assertFails(setDoc(doc(db, 'posts', 'p5'), post({ authorTier: 'clubGo' })));
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

  it('남의 폴더를 훑을 수 없음 — list 는 닫혀 있다', async () => {
    const mine = env.authenticatedContext(ALICE).storage();
    await assertFails(listAll(ref(mine, `tickets/${BOB}`)));
    await assertFails(listAll(ref(mine, `tickets/${ALICE}`)));
  });
});
