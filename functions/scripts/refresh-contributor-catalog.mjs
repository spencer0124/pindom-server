/** Split supplied photo pins and replace active prizes. Dry-run unless --apply. */
import { writeFileSync } from 'node:fs';
import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const args = process.argv.slice(2);
const arg = (name) => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
const apply = args.includes('--apply');
if (arg('--project') !== 'pindom-1234' || (apply && !arg('--backup'))) throw Error('Pass --project pindom-1234; --apply requires --backup');
const initials = ['YHJ', 'JSY', 'LJW', 'KMJ'];
const displayInitial = (initial) => initial.slice(1);
const sourceInitial = (place) => place.id.split('-')[2].toUpperCase();
const artistId = (initial) => `artist-${initial.toLowerCase()}`;
const retired = new Set(['artis-bts', 'artist-bts', 'artist-echoline', 'artist-gwandegong', 'artist-lumina', 'artist-nightpost']);
const prizes = [
  ['raffle-mj-concert', 'MJ 콘서트 티켓', 10],
  ['raffle-hj-fansign', 'HJ 팬사인회 티켓', 8],
  ['raffle-jw-cd', 'JW 사인 CD', 5],
  ['raffle-sy-album', 'SY 3집 앨범', 3],
  ['raffle-mj-photocard', 'MJ 포토카드', 1],
];
const oldRaffles = new Set(['raffle-album', 'raffle-closed', 'raffle-concert', 'raffle-demo', 'raffle-fansign']);
initializeApp({ credential: applicationDefault(), projectId: 'pindom-1234' });
const db = getFirestore();
const [artists, places, boards, users, raffles, tickets] = await Promise.all(
  ['artists', 'places', 'boards', 'users', 'raffles', 'tickets'].map((c) => db.collection(c).get()));
const photoPlaces = places.docs.filter((d) => d.data().importId === 'gwandegong-20260919' && !d.data().archived);
if (photoPlaces.length !== 23 || photoPlaces.some((d) => !initials.includes(sourceInitial(d)))) throw Error('Unexpected supplied photo catalog');
// Reuse the existing active test campaign deadline.
const closesAt = raffles.docs.find((d) => d.id === 'raffle-demo')?.data().closesAt;
if (!closesAt || closesAt.toMillis() <= Date.now()) throw Error('Existing campaign deadline has passed');
const changes = [];
const patch = (ref, fields, before) => changes.push({ ref, fields, before });
for (const [i, initial] of initials.entries()) {
  const id = artistId(initial), name = { ko: displayInitial(initial), en: displayInitial(initial) };
  const count = photoPlaces.filter((d) => sourceInitial(d) === initial).length;
  patch(db.doc(`artists/${id}`), { name, initial: displayInitial(initial), placeCount: count, archived: false }, artists.docs.find((d) => d.id === id));
  patch(db.doc(`boards/${id}`), { kind: 'artist', artistId: id, name, order: (i + 1) * 10, archived: false }, boards.docs.find((d) => d.id === id));
}
for (const d of artists.docs) if (retired.has(d.id)) patch(d.ref, { archived: true, placeCount: 0 }, d);
for (const d of boards.docs) if (retired.has(d.id) || retired.has(d.data().artistId)) patch(d.ref, { archived: true }, d);
for (const d of photoPlaces) patch(d.ref, { artistIds: [artistId(sourceInitial(d))] }, d);
const placeArtists = new Map(photoPlaces.map((d) => [d.id, artistId(sourceInitial(d))]));
for (const d of tickets.docs) {
  const owner = placeArtists.get(d.data().placeId);
  if (owner && d.data().artistId !== owner) patch(d.ref, { artistId: owner }, d);
}
for (const d of users.docs) {
  const followed = d.data().followedArtistIds ?? [];
  if (!followed.some((id) => retired.has(id))) continue;
  patch(d.ref, { followedArtistIds: [...new Set(followed.flatMap((id) => retired.has(id) ? initials.map(artistId) : [id]))] }, d);
}
for (const d of raffles.docs) if (oldRaffles.has(d.id)) patch(d.ref, { status: 'closed' }, d);
for (const [order, [id, title, ticketCost]] of prizes.entries()) {
  const existing = raffles.docs.find((d) => d.id === id);
  patch(db.doc(`raffles/${id}`), { title, prizeDescription: title, ticketCost, order, closesAt, status: 'open', imageUrl: '',
    ...(!existing && { entryCount: 0 }) }, existing);
}
if (apply) {
  writeFileSync(arg('--backup'), JSON.stringify(changes.map(({ ref, fields, before }) => ({ path: ref.path, existed: !!before,
    before: Object.fromEntries(Object.keys(fields).map((k) => [k, before?.data()[k] ?? null])) })), null, 2), { flag: 'wx', mode: 0o600 });
  const batch = db.batch();
  for (const { ref, fields, before } of changes) {
    if (before) batch.update(ref, fields, { lastUpdateTime: before.updateTime });
    else batch.create(ref, fields);
  }
  await batch.commit();
  const verified = await db.getAll(...photoPlaces.map((d) => d.ref), ...prizes.map(([id]) => db.doc(`raffles/${id}`)));
  if (verified.slice(0, 23).some((d) => d.data().artistIds[0] !== artistId(sourceInitial(d))) ||
      verified.slice(23).some((d, i) => d.data().ticketCost !== prizes[i][2])) throw Error('Verification failed');
}
console.log(JSON.stringify({ dryRun: !apply, artists: initials.map((initial) => ({ initial, places: photoPlaces.filter((d) => sourceInitial(d) === initial).length })),
  raffles: prizes.map(([id, title, ticketCost]) => ({ id, title, ticketCost })), closesAt: closesAt.toDate(), changes: changes.length }));
