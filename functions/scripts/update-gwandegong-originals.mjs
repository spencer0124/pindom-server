/** Replace cover photos only; restore Marronnier GPS. Dry-run unless --apply. */
import { createHash, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';

const args = process.argv.slice(2);
const arg = (key) => args.includes(key) ? args[args.indexOf(key) + 1] : undefined;
const directory = arg('--originals-dir');
const apply = args.includes('--apply');
const report = arg('--report');
if (!directory || arg('--project') !== 'pindom-1234' || (apply && !report)) {
  throw Error('Pass --originals-dir and --project pindom-1234; --apply also requires --report');
}
const groups = { '유형주': ['yhj', 4], '조승용': ['jsy', 3], '이지우': ['ljw', 3], '김민진': ['kmj', 13] };
const assets = readdirSync(directory).filter((name) => !name.startsWith('.')).map((name) => {
  const match = name.normalize('NFC').match(/^(유형주|조승용|이지우|김민진)(\d+) .+\.(jpg|png)$/i);
  if (!match) throw Error('Unrecognized original filename');
  const [group, count] = groups[match[1]];
  const number = Number(match[2]);
  if (number < 1 || number > count) throw Error('Unexpected source number');
  const bytes = readFileSync(resolve(directory, name));
  const ext = match[3].toLowerCase();
  const signature = ext === 'png' ? '89504e470d0a1a0a' : 'ffd8';
  if (bytes.length > 10 * 1024 * 1024 || bytes.subarray(0, signature.length / 2).toString('hex') !== signature) throw Error('Invalid image');
  return { id: `place-gdg-${group}-${String(number).padStart(2, '0')}`, bytes, ext,
    sha256: createHash('sha256').update(bytes).digest('hex'), contentType: ext === 'png' ? 'image/png' : 'image/jpeg' };
});
if (assets.length !== 23 || new Set(assets.map((asset) => asset.id)).size !== 23) throw Error('Expected all 23 unique originals');
initializeApp({ credential: applicationDefault(), projectId: 'pindom-1234', storageBucket: 'pindom-1234.firebasestorage.app' });
const db = getFirestore(), bucket = getStorage().bucket();
const before = await db.collection('places').get();
for (const asset of assets) {
  const doc = before.docs.find((doc) => doc.id === asset.id);
  if (!doc || doc.data().importId !== 'gwandegong-20260919' || doc.data().archived) throw Error('Unexpected place identity');
}
const gpsId = 'place-gdg-ljw-03';
const gps = before.docs.find((doc) => doc.id === gpsId).data();
if (gps.name.ko !== '마로니에공원' || gps.radiusMeters !== 50) throw Error('Unexpected GPS target');
if (!apply) {
  console.log(JSON.stringify({ dryRun: true, covers: assets.length, gps: { id: gpsId, radius: gps.radiusMeters },
    mapping: assets.map((a) => ({ id: a.id, place: before.docs.find((d) => d.id === a.id).data().name.ko, bytes: a.bytes.length })) }, null, 2));
} else {
  writeFileSync(`${report}.before.json`, JSON.stringify(before.docs.map((d) => ({ id: d.id, data: d.data() })), null, 2), { flag: 'wx', mode: 0o600 });
  for (const asset of assets) {
    const path = `place-assets/gwandegong-originals-20260921/${asset.sha256}.${asset.ext}`;
    const file = bucket.file(path);
    if (!(await file.exists())[0]) await file.save(asset.bytes, {
      resumable: false, preconditionOpts: { ifGenerationMatch: 0 },
      metadata: { contentType: asset.contentType, cacheControl: 'public,max-age=31536000,immutable',
        metadata: { sha256: asset.sha256, firebaseStorageDownloadTokens: randomUUID() } },
    });
    const [metadata] = await file.getMetadata();
    if (metadata.metadata?.sha256 !== asset.sha256 || !metadata.metadata?.firebaseStorageDownloadTokens) throw Error('Storage metadata mismatch');
    asset.url = `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(path)}?alt=media&token=${metadata.metadata.firebaseStorageDownloadTokens}`;
    const response = await fetch(asset.url, { headers: { Range: 'bytes=0-15' }, signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw Error('Uploaded photo is not readable');
    await response.arrayBuffer();
  }
  const batch = db.batch();
  for (const asset of assets) {
    const doc = before.docs.find((doc) => doc.id === asset.id);
    const patch = { coverImageUrl: asset.url, coverImageCredit: FieldValue.delete(), coverImageSourceUrl: FieldValue.delete(),
      'sourceMetadata.backgroundStatus': 'provided_original', 'sourceMetadata.backgroundPhoto': FieldValue.delete(),
      'sourceMetadata.coverSha256': asset.sha256 };
    if (asset.id === gpsId) patch.cameraTestEnabled = false;
    if (['place-gdg-yhj-03', 'place-gdg-jsy-01'].includes(asset.id)) {
      patch['description.ko'] = doc.data().description.ko.split(' 원본 배경사진은')[0].split(' 배경은 촬영 당시')[0];
      patch['description.en'] = doc.data().description.en.split(' Only the cutout')[0].split(' The cover is a representative')[0];
    }
    batch.update(doc.ref, patch, { lastUpdateTime: doc.updateTime });
  }
  await batch.commit();
  const after = await db.collection('places').get();
  const result = [];
  for (const doc of after.docs) {
    const old = before.docs.find((d) => d.id === doc.id).data(), next = doc.data();
    const asset = assets.find((a) => a.id === doc.id);
    if (!asset) {
      if (JSON.stringify(old) !== JSON.stringify(next)) throw Error('Unrelated place changed');
      continue;
    }
    if (next.coverImageUrl !== asset.url || next.cameraTestEnabled !== (doc.id === gpsId ? false : old.cameraTestEnabled)) throw Error('Patch verification failed');
    for (const field of ['cutoutImageUrl', 'cutoutAspectRatio', 'location', 'radiusMeters', 'artistIds']) {
      if (JSON.stringify(old[field]) !== JSON.stringify(next[field])) throw Error(`Protected field changed: ${field}`);
    }
    result.push({ id: doc.id, coverImageUrl: next.coverImageUrl, cameraTestEnabled: next.cameraTestEnabled, sha256: asset.sha256, description: next.description });
  }
  writeFileSync(report, JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ verifiedCovers: result.length, gpsRestored: gpsId, radiusMeters: gps.radiusMeters, otherPlacesUnchanged: true }));
}
