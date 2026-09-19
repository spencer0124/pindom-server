import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ARTIST_ID, IMPORT_ID, checkExisting, contentHash, validateManifest } from '../scripts/import-gwandegong.mjs';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'pindom-import-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const assets = {};
  for (const [kind, signature, ext, contentType] of [
    ['cover', 'ffd8', 'jpg', 'image/jpeg'], ['cutout', '89504e470d0a1a0a', 'png', 'image/png'],
  ]) {
    const data = Buffer.from(signature, 'hex');
    const fileName = `${kind}.${ext}`;
    writeFileSync(join(dir, fileName), data);
    assets[kind] = { fileName, sha256: createHash('sha256').update(data).digest('hex'), bytes: data.length, width: 100, height: 200, contentType };
  }
  const places = [];
  for (const [group, label, count] of [['yhj', 'YHJ', 4], ['jsy', 'JSY', 3], ['ljw', 'LJW', 3], ['kmj', 'KMJ', 13]]) {
    for (let i = 1; i <= count; i++) places.push({
      id: `place-gdg-${group}-${String(i).padStart(2, '0')}`, contributorInitials: label,
      name: { ko: '장소', en: 'Place' }, description: { ko: '사진', en: 'Photo' },
      region: { ko: '서울', en: 'Seoul' }, workTitle: { ko: '관데공', en: 'Gwandegong' },
      address: '서울 종로구', roman: 'Place', workKind: 'self', artistIds: [ARTIST_ID],
      lat: 37.5, lng: 127, radiusMeters: 50, cutoutAspectRatio: 0.5, assets: structuredClone(assets),
    });
  }
  return { dir, manifest: { importId: IMPORT_ID, artist: { id: ARTIST_ID }, places } };
}

test('accepts a complete 23-photo plan without writing remote data', (t) => {
  const { dir, manifest } = fixture(t);
  assert.equal(validateManifest(manifest, dir), manifest);
});

test('rejects duplicates, contributor swaps and implausible coordinates', (t) => {
  const { dir, manifest } = fixture(t);
  for (const edit of [
    (m) => { m.places[1].id = m.places[0].id; },
    (m) => { m.places[0].contributorInitials = 'KMJ'; },
    (m) => { m.places[0].lat = 0; },
    (m) => { m.places[0].radiusMeters = 2000; },
  ]) {
    const changed = structuredClone(manifest); edit(changed);
    assert.throws(() => validateManifest(changed, dir));
  }
});

test('rejects asset substitution and paths outside the asset directory', (t) => {
  const { dir, manifest } = fixture(t);
  manifest.places[0].assets.cutout.fileName = '../cutout.png';
  assert.throws(() => validateManifest(manifest, dir), /unsafe asset/);
  manifest.places[0].assets.cutout.fileName = 'cutout.png';
  writeFileSync(join(dir, 'cutout.png'), 'different content');
  assert.throws(() => validateManifest(manifest, dir), /checksum/);
});

test('reruns keep existing counters while unrelated or changed records are protected', (t) => {
  const { manifest } = fixture(t);
  const place = manifest.places[0];
  assert.equal(checkExisting(undefined, place), 'create');
  const existing = { importId: IMPORT_ID, importContentHash: contentHash(place), ticketCount: 99 };
  assert.equal(checkExisting(existing, place), 'keep');
  assert.equal(existing.ticketCount, 99);
  assert.throws(() => checkExisting({ ticketCount: 99 }, place), /refusing to overwrite/);
  assert.throws(() => checkExisting(existing, { ...place, lat: 37.6 }), /refusing to overwrite/);
});

test('missing covers stay explicit and an API cover requires the recorded license', (t) => {
  const { dir, manifest } = fixture(t);
  const place = manifest.places[0];
  delete place.assets.cover;
  place.coverImageUrl = '';
  assert.throws(() => validateManifest(manifest, dir), /explicitly documented/);
  place.sourceMetadata = { backgroundStatus: 'missing' };
  assert.equal(validateManifest(manifest, dir), manifest);
  place.coverImageUrl = 'https://tong.visitkorea.or.kr/cms/photo.jpg';
  assert.throws(() => validateManifest(manifest, dir), /explicitly documented/);
  place.sourceMetadata = { backgroundStatus: 'api_representative_photo', backgroundPhoto: { licenseCode: 'Type1' } };
  assert.equal(validateManifest(manifest, dir), manifest);
});
