/** Retire known fixtures and control camera testing. Dry-run unless --apply. */
import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';

const args = process.argv.slice(2);
const project = args[args.indexOf('--project') + 1];
const archive = args.includes('--archive-test-places');
const enable = args.includes('--enable-camera');
const disable = args.includes('--disable-camera');
const apply = args.includes('--apply');
const onlyPlace = args.includes('--only-place') ? args[args.indexOf('--only-place') + 1] : null;
const exceptPlace = args.includes('--except-place') ? args[args.indexOf('--except-place') + 1] : null;
if (args.includes('--except-place') && (!enable || onlyPlace || !exceptPlace || exceptPlace.startsWith('--'))) {
  throw Error('--except-place requires --enable-camera and a place ID, without --only-place');
}
if (args.includes('--only-place') && (!enable || !onlyPlace || onlyPlace.startsWith('--'))) {
  throw Error('--only-place requires --enable-camera and a place ID');
}
if (project !== 'pindom-1234' || enable === disable) {
  throw Error('Pass --project pindom-1234 and exactly one of --enable-camera / --disable-camera');
}
const legacyPlaces = new Set([
  'place-jumunjin', 'place-gamcheon', 'place-namsan', 'place-cheonggye',
  'place-eurwangni', 'place-hyehwa', 'place-hyehwa-skk', 'place-test-anywhere',
]);
const legacyCourses = new Set(['course-gangneung', 'course-seoul-night']);
initializeApp({ credential: applicationDefault(), projectId: project });
const db = getFirestore();
const result = await db.runTransaction(async (tx) => {
  const [places, courses, artists] = await Promise.all([
    tx.get(db.collection('places')), tx.get(db.collection('courses')), tx.get(db.collection('artists')),
  ]);
  if (archive && [...legacyPlaces].some((id) => !places.docs.some((doc) => doc.id === id))) {
    throw Error('A reviewed fixture is missing; inspect the catalog before continuing');
  }
  const changes = [];
  if (onlyPlace && !places.docs.some((doc) => doc.id === onlyPlace && doc.data().archived !== true)) {
    throw Error('The camera-test place must exist and be active');
  }
  if (exceptPlace && !places.docs.some((doc) => doc.id === exceptPlace && doc.data().archived !== true)) {
    throw Error('The excluded place must exist and be active');
  }
  const active = [];
  const affectedArtists = new Set(places.docs
    .filter((doc) => legacyPlaces.has(doc.id))
    .flatMap((doc) => doc.data().artistIds ?? []));
  const update = (doc, fields) => {
    const patch = Object.fromEntries(Object.entries(fields).filter(([key, value]) => doc.data()[key] !== value));
    if (!Object.keys(patch).length) return;
    changes.push({ path: doc.ref.path, fields: Object.keys(patch) });
    if (apply) tx.update(doc.ref, patch);
  };
  for (const doc of places.docs) {
    const data = doc.data();
    if (archive && legacyPlaces.has(doc.id)) {
      update(doc, {
        archived: true, cameraTestEnabled: false,
        ...(data.archived !== true && { archivedAt: FieldValue.serverTimestamp(), archiveReason: 'test-fixture-cleanup' }),
      });
    } else if (data.archived !== true) {
      active.push(data);
      update(doc, { cameraTestEnabled: enable && (!onlyPlace || doc.id === onlyPlace) && doc.id !== exceptPlace });
    } else if (onlyPlace || exceptPlace) {
      update(doc, { cameraTestEnabled: false });
    }
  }
  if (archive) {
    for (const doc of courses.docs) if (legacyCourses.has(doc.id)) {
      update(doc, { archived: true });
    }
    for (const doc of artists.docs) if (affectedArtists.has(doc.id)) {
      update(doc, { placeCount: active.filter((place) => place.artistIds?.includes(doc.id)).length });
    }
  }
  return { dryRun: !apply, activePlaces: active.length, cameraTestEnabled: enable, onlyPlace, exceptPlace, changes };
});
console.log(JSON.stringify(result, null, 2));
