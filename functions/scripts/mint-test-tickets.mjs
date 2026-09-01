// 테스트 티켓 발급: 모든 users 문서에 10장씩, 40일 전 발행으로 (쿨다운·속도 게이트 회피).
import { initializeApp } from 'firebase-admin/app';
import { FieldValue, Timestamp, getFirestore } from 'firebase-admin/firestore';
import { randomBytes } from 'node:crypto';
import { mintSerial } from '../lib/logic.js';

const PLACE_ID = 'place-cheonggye';
const COUNT = 10;
const DAYS_AGO = 40;

initializeApp({ projectId: 'pindom-1234' });
const db = getFirestore();

const place = (await db.doc(`places/${PLACE_ID}`).get()).data();
if (!place) throw new Error('place 없음');
const placeName = place.name?.ko ?? '';
const artistId = place.artistIds?.[0];

const users = await db.collection('users').get();
for (const u of users.docs) {
  const uid = u.id;
  const hasHere = !(await db.collection('tickets')
    .where('userId', '==', uid).where('placeId', '==', PLACE_ID).limit(1).get()).empty;

  const batch = db.batch();
  for (let i = 0; i < COUNT; i += 1) {
    const issuedAt = Timestamp.fromMillis(
      Date.now() - DAYS_AGO * 24 * 60 * 60 * 1000 + i * 60 * 1000,
    );
    batch.set(db.collection('tickets').doc(), {
      userId: uid,
      placeId: PLACE_ID,
      placeName,
      photoPath: `tickets/${uid}/test-${i}.jpg`,
      photoUrl: `https://picsum.photos/seed/test-${uid.slice(0, 6)}-${i}/1200/1600`,
      serial: mintSerial(randomBytes(8)),
      visibility: 'private',
      issuedAt,
      spent: false,
      ...(artistId && { artistId }),
    });
  }
  batch.set(u.ref, {
    ticketBalance: FieldValue.increment(COUNT),
    ticketsIssued: FieldValue.increment(COUNT),
    ...(!hasHere && { placesVisited: FieldValue.increment(1) }),
  }, { merge: true });
  batch.set(db.doc(`places/${PLACE_ID}`), {
    ticketCount: FieldValue.increment(COUNT),
    photoCount: FieldValue.increment(COUNT),
  }, { merge: true });
  await batch.commit();
  console.log(uid, u.data().nickname ?? '(닉네임 없음)', `+${COUNT}장`);
}
console.log('완료');
