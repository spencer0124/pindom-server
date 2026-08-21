/**
 * 시드 데이터 적재. 문서 id 가 고정이라 여러 번 돌려도 같은 상태가 된다.
 *
 *   에뮬레이터:  npm --prefix functions run seed
 *   실제 프로젝트: npm --prefix functions run seed -- --project pindom-xxxx --yes
 *
 * 카운터(ticketCount·verifyCount·photoCount·reviewCount·placeCount·memberCount·entryCount)는
 * 함수가 채우는 값이라 여기서는 0 으로 넣는다. 목 데이터의 1284 같은 숫자를 그대로 옮기면
 * 화면에는 그럴듯하게 보이지만 첫 발행에서 어긋난다.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { initializeApp } from 'firebase-admin/app';
import { FieldValue, GeoPoint, Timestamp, getFirestore } from 'firebase-admin/firestore';

const here = dirname(fileURLToPath(import.meta.url));
const data = JSON.parse(readFileSync(join(here, 'seed-data.json'), 'utf8'));

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args[i + 1];
};
const projectId = flag('project') ?? process.env.GCLOUD_PROJECT ?? 'pindom-seed-local';
const onEmulator = Boolean(process.env.FIRESTORE_EMULATOR_HOST);

// 실제 프로젝트에 쓰는 것은 되돌리기 어려운 동작이다. 에뮬레이터가 아니면 명시적 동의를 받는다.
if (!onEmulator && !args.includes('--yes')) {
  console.error(`실제 프로젝트(${projectId})에 씁니다. 확인했으면 --yes 를 붙이세요.`);
  process.exit(1);
}

initializeApp({ projectId });
const db = getFirestore();

const placesOf = (artistId) => data.places.filter((p) => p.artistIds.includes(artistId));

const batch = db.batch();

for (const artist of data.artists) {
  const { id, ...rest } = artist;
  batch.set(db.doc(`artists/${id}`), {
    ...rest,
    placeCount: placesOf(id).length,
    memberCount: 0,
  });
}

for (const place of data.places) {
  const { id, lat, lng, ...rest } = place;
  batch.set(db.doc(`places/${id}`), {
    ...rest,
    location: new GeoPoint(lat, lng),
    ticketCount: 0,
    verifyCount: 0,
    photoCount: 0,
    reviewCount: 0,
    createdAt: FieldValue.serverTimestamp(),
  });
}

for (const course of data.courses) {
  const { id, ...rest } = course;
  batch.set(db.doc(`courses/${id}`), { ...rest, placeCount: course.placeIds.length });
}

for (const raffle of data.raffles) {
  const { id, closesInHours, ...rest } = raffle;
  batch.set(db.doc(`raffles/${id}`), {
    ...rest,
    closesAt: Timestamp.fromMillis(Date.now() + closesInHours * 60 * 60 * 1000),
    entryCount: 0,
  });
}

await batch.commit();

const counts = [
  ['artists', data.artists.length],
  ['places', data.places.length],
  ['courses', data.courses.length],
  ['raffles', data.raffles.length],
];
console.log(`${projectId}${onEmulator ? ' (에뮬레이터)' : ''} 적재 완료`);
for (const [name, n] of counts) console.log(`  ${name} ${n}`);
