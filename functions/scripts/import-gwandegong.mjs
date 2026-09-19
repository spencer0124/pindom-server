/** Add only the reviewed Gwandegong photo pins. Dry-run is the default. */
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { GeoPoint, Timestamp, getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';

export const IMPORT_ID = 'gwandegong-20260919';
export const ARTIST_ID = 'artist-gwandegong';
const hash = (value) => createHash('sha256').update(value).digest('hex');

export function validateManifest(manifest, assetsDir) {
  if (manifest.importId !== IMPORT_ID || manifest.artist.id !== ARTIST_ID) throw Error('Wrong import identity');
  if (!Array.isArray(manifest.places) || manifest.places.length !== 23) throw Error('Expected 23 places');
  const ids = new Set();
  for (const place of manifest.places) {
    if (!/^place-gdg-(yhj|jsy|ljw|kmj)-\d{2}$/.test(place.id) || ids.has(place.id)) throw Error('Invalid or duplicate place id');
    ids.add(place.id);
    const expectedInitials = { yhj: 'YHJ', jsy: 'JSY', ljw: 'LJW', kmj: 'KMJ' }[place.id.split('-')[2]];
    if (place.contributorInitials !== expectedInitials) throw Error('Contributor initials do not match the source group');
    for (const field of ['name', 'description', 'region', 'workTitle']) {
      if (!place[field]?.ko || !place[field]?.en) throw Error(`${place.id}: ${field} needs both locales`);
    }
    if (!Number.isFinite(place.lat) || place.lat < 33 || place.lat > 39 ||
        !Number.isFinite(place.lng) || place.lng < 124 || place.lng > 132) throw Error(`${place.id}: invalid Korea coordinates`);
    if (!(place.radiusMeters > 0 && place.radiusMeters <= 500)) throw Error(`${place.id}: invalid radius`);
    if (place.artistIds?.length !== 1 || place.artistIds[0] !== ARTIST_ID) throw Error('Unexpected artist mapping');
    if (place.workKind !== 'self' || !place.address || !place.roman) throw Error(`${place.id}: incomplete place`);
    for (const kind of ['cover', 'cutout']) {
      const asset = place.assets?.[kind];
      if (kind === 'cover' && !asset) {
        const external = place.coverImageUrl;
        if (external === '' && place.sourceMetadata?.backgroundStatus === 'missing') continue;
        if (external?.startsWith('https://tong.visitkorea.or.kr/') && place.sourceMetadata?.backgroundPhoto?.licenseCode === 'Type1') continue;
        throw Error(`${place.id}: missing cover must be explicitly documented`);
      }
      if (!asset || basename(asset.fileName) !== asset.fileName || !/^[a-z0-9.-]+$/.test(asset.fileName)) throw Error(`${place.id}: missing or unsafe asset`);
      const bytes = readFileSync(resolve(assetsDir, asset.fileName));
      if (hash(bytes) !== asset.sha256 || bytes.length !== asset.bytes) throw Error(`${place.id}: asset checksum mismatch`);
      if (!(asset.width > 0 && asset.height > 0 && bytes.length < 10 * 1024 * 1024)) throw Error(`${place.id}: invalid asset dimensions/size`);
      if (asset.contentType !== (kind === 'cover' ? 'image/jpeg' : 'image/png')) throw Error(`${place.id}: wrong image type`);
      const signature = kind === 'cover' ? 'ffd8' : '89504e470d0a1a0a';
      if (!bytes.subarray(0, signature.length / 2).equals(Buffer.from(signature, 'hex'))) throw Error(`${place.id}: invalid image signature`);
    }
    const ratio = place.assets.cutout.width / place.assets.cutout.height;
    if (Math.abs(place.cutoutAspectRatio - ratio) > 0.000001) throw Error(`${place.id}: cutout ratio mismatch`);
  }
  for (const [group, count] of [['yhj', 4], ['jsy', 3], ['ljw', 3], ['kmj', 13]]) {
    for (let i = 1; i <= count; i++) if (!ids.has(`place-gdg-${group}-${String(i).padStart(2, '0')}`)) throw Error('Missing source number');
  }
  return manifest;
}

export function contentHash(place) { return hash(JSON.stringify(place)); }

export function checkExisting(existing, place) {
  if (!existing) return 'create';
  if (existing.importId === IMPORT_ID && existing.importContentHash === contentHash(place)) return 'keep';
  throw Error(`${place.id}: existing document differs; refusing to overwrite`);
}

async function upload(bucket, asset, assetsDir) {
  const path = `place-assets/${IMPORT_ID}/${asset.sha256}.${asset.contentType === 'image/png' ? 'png' : 'jpg'}`;
  const file = bucket.file(path);
  const [exists] = await file.exists();
  if (!exists) {
    await file.save(readFileSync(resolve(assetsDir, asset.fileName)), {
      resumable: false, preconditionOpts: { ifGenerationMatch: 0 },
      metadata: {
        contentType: asset.contentType, cacheControl: 'public,max-age=31536000,immutable',
        metadata: { sha256: asset.sha256, importId: IMPORT_ID, firebaseStorageDownloadTokens: randomUUID() },
      },
    });
  }
  const [metadata] = await file.getMetadata();
  if (metadata.metadata?.sha256 !== asset.sha256 || metadata.metadata?.importId !== IMPORT_ID) throw Error('Unrecognized existing storage object');
  const token = metadata.metadata?.firebaseStorageDownloadTokens;
  if (!token) throw Error('Storage download token missing');
  return `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(path)}?alt=media&token=${token}`;
}

export async function run(args) {
  const arg = (name, fallback) => { const i = args.indexOf(name); return i === -1 ? fallback : args[i + 1]; };
  const manifestPath = arg('--manifest', fileURLToPath(new URL('./data/gwandegong.json', import.meta.url)));
  const assetsDir = arg('--assets-dir');
  if (!assetsDir) throw Error('--assets-dir is required');
  const manifest = validateManifest(JSON.parse(readFileSync(manifestPath, 'utf8')), assetsDir);
  const summary = { places: manifest.places.length,
    assets: manifest.places.reduce((n, p) => n + Object.keys(p.assets).length, 0),
    bytes: manifest.places.reduce((n, p) => n + (p.assets.cover?.bytes ?? 0) + p.assets.cutout.bytes, 0),
    importId: IMPORT_ID };
  if (!args.includes('--apply')) { console.log(JSON.stringify({ dryRun: true, ...summary })); return; }
  const projectId = arg('--project');
  const bucketName = arg('--bucket');
  if (projectId !== 'pindom-1234' || bucketName !== 'pindom-1234.firebasestorage.app') throw Error('Explicit production project and bucket are required');
  initializeApp({ credential: applicationDefault(), projectId, storageBucket: bucketName });
  const db = getFirestore();
  const bucket = getStorage().bucket();
  const refs = manifest.places.map((p) => db.doc(`places/${p.id}`));
  const existing = await db.getAll(...refs);
  existing.forEach((s, i) => checkExisting(s.data(), manifest.places[i]));
  const artistRef = db.doc(`artists/${ARTIST_ID}`);
  const artistBefore = await artistRef.get();
  if (artistBefore.exists && artistBefore.data().importId !== IMPORT_ID) throw Error('Existing artist is not owned by this import');
  const timestamp = Timestamp.now();
  const documents = [];
  for (const place of manifest.places) {
    const { id, lat, lng, assets, ...fields } = place;
    const coverImageUrl = assets.cover ? await upload(bucket, assets.cover, assetsDir) : place.coverImageUrl;
    const cutoutImageUrl = await upload(bucket, assets.cutout, assetsDir);
    documents.push({ id, ...fields, location: new GeoPoint(lat, lng), coverImageUrl, cutoutImageUrl,
      ticketCount: 0, verifyCount: 0, photoCount: 0, reviewCount: 0, createdAt: timestamp,
      importId: IMPORT_ID, importContentHash: contentHash(place) });
  }
  const result = await db.runTransaction(async (tx) => {
    const snapshots = await tx.getAll(artistRef, ...refs);
    const linked = await tx.get(db.collection('places').where('artistIds', 'array-contains', ARTIST_ID));
    const artist = snapshots[0];
    if (artist.exists && artist.data().importId !== IMPORT_ID) throw Error('Artist changed during import');
    const states = snapshots.slice(1).map((s, i) => checkExisting(s.data(), manifest.places[i]));
    for (let i = 0; i < documents.length; i++) {
      if (states[i] === 'create') { const { id, ...doc } = documents[i]; tx.create(refs[i], doc); }
    }
    const placeCount = new Set([...linked.docs.map((d) => d.id), ...manifest.places.map((p) => p.id)]).size;
    const { id, ...artistFields } = manifest.artist;
    if (!artist.exists) tx.create(artistRef, { ...artistFields, placeCount, importId: IMPORT_ID });
    else tx.update(artistRef, { placeCount });
    return { created: states.filter((s) => s === 'create').length, kept: states.filter((s) => s === 'keep').length };
  });
  const final = await db.getAll(...refs);
  const places = final.map((snap) => {
    const { location, createdAt, importContentHash, ...fields } = snap.data();
    return { id: snap.id, ...fields, lat: location.latitude, lng: location.longitude, createdAt: createdAt.toDate().toISOString() };
  });
  const output = arg('--catalog-out');
  if (output) writeFileSync(output, JSON.stringify({ artist: { ...manifest.artist, placeCount: places.length }, places }, null, 2) + '\n');
  console.log(JSON.stringify({ ...summary, ...result, verified: final.every((s, i) => checkExisting(s.data(), manifest.places[i]) === 'keep') }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run(process.argv.slice(2)).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
