/**
 * 시드 데이터 적재. 문서 id 가 고정이라 여러 번 돌려도 같은 상태가 된다.
 *
 *   에뮬레이터:  npm --prefix functions run seed
 *   실제 프로젝트: npm --prefix functions run seed -- --project pindom-xxxx --yes
 *
 * 카운터(ticketCount·verifyCount·photoCount·placeCount·entryCount)는
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
const projectId =
  args[args.indexOf('--project') + 1] ?? process.env.GCLOUD_PROJECT ?? 'pindom-seed-local';
const onEmulator = Boolean(process.env.FIRESTORE_EMULATOR_HOST);

// 실제 프로젝트에 쓰는 것은 되돌리기 어려운 동작이다. 에뮬레이터가 아니면 명시적 동의를 받는다.
if (!onEmulator && !args.includes('--yes')) {
  console.error(`실제 프로젝트(${projectId})에 씁니다. 확인했으면 --yes 를 붙이세요.`);
  process.exit(1);
}

initializeApp({ projectId });
const db = getFirestore();

const placesOf = (artistId) => data.places.filter((p) => p.artistIds.includes(artistId));

/**
 * 이미 있는 문서의 카운터는 건드리지 않는다. 두 번째 실행이 ticketCount 를 0 으로 되돌리면
 * 발행 이력과 화면 숫자가 어긋나고, 그 어긋남은 다음 발행 전까지 드러나지도 않는다.
 * 시드가 소유하는 것은 내용이고, 카운터는 함수가 소유한다.
 */
async function upsert(path, content, initialOnly) {
  const ref = db.doc(path);
  const exists = (await ref.get()).exists;
  await ref.set(exists ? content : { ...content, ...initialOnly }, { merge: true });
  return exists;
}

let kept = 0;

for (const artist of data.artists) {
  const { id, ...rest } = artist;
  const existed = await upsert(`artists/${id}`, { ...rest, placeCount: placesOf(id).length }, {});
  if (existed) kept += 1;
}

// 게시판. 아이돌 게시판은 아티스트에서 파생한다 — 문서 id 가 곧 artistId 라
// (앱 계약서의 posts.boardId 정의) 아티스트 목록과 어긋날 수 없게 한 번에 만든다.
// seed-data.json 이 직접 들고 있는 것은 아티스트에 매이지 않는 자유게시판뿐이다.
const artistBoards = data.artists.map((artist, i) => ({
  id: artist.id,
  kind: 'artist',
  artistId: artist.id,
  name: artist.name,
  order: (i + 1) * 10,
  ...(artist.accentColor && { accentColor: artist.accentColor }),
}));

for (const board of [...data.boards, ...artistBoards]) {
  const { id, ...rest } = board;
  // archived 는 관리 도구가 소유한다. 여기서 매번 false 로 되돌리면 내려둔 게시판이
  // 시드 한 번에 다시 올라온다.
  await upsert(`boards/${id}`, rest,
    { archived: false, createdAt: FieldValue.serverTimestamp() });
}

for (const place of data.places) {
  const { id, lat, lng, ...rest } = place;
  const existed = await upsert(`places/${id}`,
    { ...rest, location: new GeoPoint(lat, lng) },
    {
      ticketCount: 0, verifyCount: 0, photoCount: 0,
      createdAt: FieldValue.serverTimestamp(),
    });
  if (existed) kept += 1;
}

for (const course of data.courses) {
  const { id, ...rest } = course;
  await upsert(`courses/${id}`, { ...rest, placeCount: course.placeIds.length }, {});
}

for (const raffle of data.raffles) {
  const { id, closesInHours, status, ...rest } = raffle;
  const ref = db.doc(`raffles/${id}`);
  const existed = (await ref.get()).exists;
  await ref.set(
    existed
      ? rest
      : {
          ...rest,
          status,
          closesAt: Timestamp.fromMillis(Date.now() + closesInHours * 60 * 60 * 1000),
          entryCount: 0,
        },
    { merge: true },
  );
  if (existed) kept += 1;
}

const counts = [
  ['artists', data.artists.length],
  ['boards', data.boards.length + artistBoards.length],
  ['places', data.places.length],
  ['courses', data.courses.length],
  ['raffles', data.raffles.length],
];
console.log(`${projectId}${onEmulator ? ' (에뮬레이터)' : ''} 적재 완료`);
for (const [name, n] of counts) console.log(`  ${name} ${n}`);
if (kept) console.log(`  이미 있던 ${kept}건은 카운터를 그대로 뒀다`);
