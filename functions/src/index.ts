import { randomBytes, randomUUID } from 'node:crypto';

import { initializeApp } from 'firebase-admin/app';
import { FieldValue, GeoPoint, Timestamp, getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import { setGlobalOptions } from 'firebase-functions';
import { HttpsError, onCall, type CallableRequest } from 'firebase-functions/v2/https';

import {
  ACCURACY_GATE_M,
  CLOCK_SKEW_MIN,
  DEFAULT_RADIUS_M,
  GRANT_TTL_MIN,
  IDEMPOTENCY_KEY_RE,
  MAX_READINGS,
  SESSION_SPEED_KMH,
  TICKET_SPEED_KMH,
  cooldownEndsAt,
  distanceMeters,
  effectiveDistance,
  isImplausibleJump,
  mintSerial,
  tierFor,
  type LatLng,
} from './logic';

// 리전은 한 번 정하면 함수를 지우고 다시 배포해야만 바뀐다.
// 앱은 getFunctions(app, 'asia-northeast3') 로 호출한다 —
// 기본값 us-central1 로 호출하면 not-found 가 난다.
// 인스턴스 상한을 둔다. App Check 이 없고 함수 URL 은 공개라, 스크립트로 때리면 인스턴스가
// 무한히 늘고 그대로 청구서가 된다. 초기 사용자 규모에는 10 이면 넉넉하다.
setGlobalOptions({ region: 'asia-northeast3', maxInstances: 10 });

initializeApp();
const db = getFirestore();

type Data = Record<string, unknown>;

function requireUid(req: CallableRequest): string {
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', '로그인이 필요하다');
  return uid;
}

function str(data: Data, key: string): string {
  const v = data[key];
  if (typeof v !== 'string' || v === '') {
    throw new HttpsError('invalid-argument', `${key} 가 없거나 문자열이 아니다`);
  }
  return v;
}

function num(data: Data, key: string): number {
  const v = data[key];
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new HttpsError('invalid-argument', `${key} 가 없거나 숫자가 아니다`);
  }
  return v;
}

function precondition(errorCode: string, extra: Data = {}): HttpsError {
  return new HttpsError('failed-precondition', errorCode, { errorCode, ...extra });
}

const geo = (p: GeoPoint): LatLng => ({ lat: p.latitude, lng: p.longitude });

// ─────────────────────────────────────────────────────────────────────────────
// verifyLocation
// ─────────────────────────────────────────────────────────────────────────────

interface Reading {
  location: GeoPoint;
  accuracy: number;
  capturedAt: Timestamp;
  distanceMeters: number;
}

/**
 * GPS 판정. 거부는 throw 가 아니라 verified: false 다 — 66m 떨어져 있는 것은 정상적인
 * 결과이지 고장이 아니고, 인증 실패 화면이 거리·반경·정확도를 표로 렌더링한다.
 */
export const verifyLocation = onCall(async (req) => {
  const uid = requireUid(req);
  const data = (req.data ?? {}) as Data;

  const placeId = str(data, 'placeId');
  const lat = num(data, 'lat');
  const lng = num(data, 'lng');
  const accuracy = num(data, 'accuracy');
  const capturedAt = new Date(str(data, 'capturedAt'));
  if (Number.isNaN(capturedAt.getTime())) {
    throw new HttpsError('invalid-argument', 'capturedAt 이 ISO 8601 이 아니다');
  }
  // 시각은 클라이언트가 보낸 값이라 속도 계산의 분모다. 과거 시각을 넣으면 어떤 이동도
  // 느려 보여 속도 검사가 통째로 무력해진다. 서버 시각에서 멀면 받지 않는다.
  if (Math.abs(Date.now() - capturedAt.getTime()) > CLOCK_SKEW_MIN * 60 * 1000) {
    throw new HttpsError('invalid-argument', 'capturedAt 이 서버 시각과 너무 멀다');
  }
  const isMock = data.isMock === true;
  const sessionId = typeof data.sessionId === 'string' ? data.sessionId : undefined;

  // 기준 좌표는 반드시 서버가 가진 값이다. 클라이언트가 보낸 좌표는 판정 대상일 뿐이다.
  const placeSnap = await db.doc(`places/${placeId}`).get();
  const place = placeSnap.data();
  if (!place) throw new HttpsError('not-found', '없는 장소다');
  const center = place.location as GeoPoint;
  const radius = typeof place.radiusMeters === 'number' ? place.radiusMeters : DEFAULT_RADIUS_M;

  const distance = effectiveDistance(distanceMeters(geo(center), { lat, lng }), accuracy);

  const sessionRef = sessionId
    ? db.doc(`verificationSessions/${sessionId}`)
    : db.collection('verificationSessions').doc();

  let readings: Reading[] = [];
  if (sessionId) {
    const snap = await sessionRef.get();
    const session = snap.data();
    if (!session) throw new HttpsError('not-found', '없는 세션이다');
    if (session.userId !== uid) throw new HttpsError('permission-denied', '남의 세션이다');
    if (session.placeId !== placeId) {
      throw new HttpsError('invalid-argument', '세션의 장소와 다르다');
    }
    readings = (session.readings as Reading[] | undefined) ?? [];
  }

  const reject = async (reason: string, append: boolean) => {
    await writeSession(sessionRef, uid, placeId, readings, append ? newReading() : undefined, null);
    return {
      sessionId: sessionRef.id,
      verified: false,
      distanceMeters: distance,
      requiredRadiusMeters: radius,
      accuracyMeters: accuracy,
      reason,
    };
  };

  const newReading = (): Reading => ({
    location: new GeoPoint(lat, lng),
    accuracy,
    capturedAt: Timestamp.fromDate(capturedAt),
    distanceMeters: distance,
  });

  if (isMock) return reject('mock_location', true);

  // 오차 200m 짜리 샘플이 배열에 남으면 다음 속도 계산을 오염시킨다. 기록하지 않는다.
  if (accuracy > ACCURACY_GATE_M) return reject('poor_accuracy', false);

  if (distance > radius) return reject('out_of_radius', true);

  const last = readings[readings.length - 1];
  if (last) {
    const moved = distanceMeters(geo(last.location), { lat, lng });
    const seconds = (capturedAt.getTime() - last.capturedAt.toDate().getTime()) / 1000;
    if (isImplausibleJump(moved, seconds, SESSION_SPEED_KMH)) {
      return reject('implausible_speed', true);
    }
  }

  // 직전 티켓 대비 검사는 "여기 도착했는가" 를 보는 것이라 세션의 첫 측정에서만 의미가 있다.
  // 이후 측정은 바로 위 세션 내부 검사가 덮는다. 인증 화면은 같은 세션으로 여러 번 호출하므로
  // 매번 돌리면 핑마다 문서를 둘씩 더 읽는다.
  if (readings.length === 0 && (await jumpedFromLastTicket(uid, { lat, lng }, capturedAt))) {
    return reject('implausible_speed', true);
  }

  const grantExpiresAt = Timestamp.fromMillis(Date.now() + GRANT_TTL_MIN * 60 * 1000);
  await writeSession(sessionRef, uid, placeId, readings, newReading(), grantExpiresAt);

  return {
    sessionId: sessionRef.id,
    verified: true,
    distanceMeters: distance,
    requiredRadiusMeters: radius,
    accuracyMeters: accuracy,
    // 토큰이 곧 세션 id 다. 별도 토큰 문서를 두지 않는 이유는, 소유자·만료·단발성이 전부
    // 세션 문서에 이미 있어서다. 남의 세션 id 를 알아도 userId 검사에서 막힌다.
    grant: { token: sessionRef.id, expiresAt: grantExpiresAt.toDate().toISOString() },
  };
});

async function writeSession(
  ref: FirebaseFirestore.DocumentReference,
  uid: string,
  placeId: string,
  existing: Reading[],
  append: Reading | undefined,
  grantExpiresAt: Timestamp | null,
): Promise<void> {
  const readings = append ? [...existing, append].slice(-MAX_READINGS) : existing;
  const startedAt = Timestamp.now();
  await ref.set(
    {
      userId: uid,
      placeId,
      readings,
      status: grantExpiresAt ? 'verified' : 'active',
      ...(grantExpiresAt && { grantExpiresAt }),
      // TTL 정책이 지우는 필드. grantExpiresAt 은 실패한 세션에 없어서 이 역할을 못 한다.
      ...(existing.length === 0 && {
        startedAt,
        expiresAt: Timestamp.fromMillis(startedAt.toMillis() + 24 * 60 * 60 * 1000),
      }),
    },
    { merge: true },
  );
}

/** 직전에 티켓을 받은 장소에서 여기까지, 사람이 갈 수 있는 속도였는가. */
async function jumpedFromLastTicket(uid: string, here: LatLng, at: Date): Promise<boolean> {
  const snap = await db
    .collection('tickets')
    .where('userId', '==', uid)
    .orderBy('issuedAt', 'desc')
    .limit(1)
    .get();
  const ticket = snap.docs[0]?.data();
  if (!ticket) return false;

  const placeSnap = await db.doc(`places/${ticket.placeId}`).get();
  const location = placeSnap.data()?.location as GeoPoint | undefined;
  if (!location) return false;

  const moved = distanceMeters(geo(location), here);
  const seconds = (at.getTime() - (ticket.issuedAt as Timestamp).toDate().getTime()) / 1000;
  return isImplausibleJump(moved, seconds, TICKET_SPEED_KMH);
}

// ─────────────────────────────────────────────────────────────────────────────
// issueTicket
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 티켓 발행. 인증 한 번이 티켓 한 장이 되도록 그랜트를 소비한다.
 * 카메라를 UI 에서만 잠그면 고친 앱이 그냥 지나가므로, 발행 권한은 그랜트가 갖는다.
 */
export const issueTicket = onCall(async (req) => {
  const uid = requireUid(req);
  const data = (req.data ?? {}) as Data;
  const grantToken = str(data, 'grantToken');
  const photoPath = str(data, 'photoPath');
  const visibility = str(data, 'visibility');
  if (visibility !== 'public' && visibility !== 'private') {
    throw new HttpsError('invalid-argument', 'visibility 는 public 또는 private 이다');
  }

  // 그랜트는 여기서 한 번 보고 트랜잭션 안에서 다시 본다. 이 바깥 확인만 두면 같은 그랜트로
  // 두 번 호출한 요청이 동시에 통과해 티켓이 두 장 나온다 — 인증 한 번에 티켓 한 장이라는
  // 성질이 무너진다. 바깥 확인은 placeId 를 얻고 실패를 일찍 돌려주기 위한 것이다.
  const sessionRef = db.doc(`verificationSessions/${grantToken}`);
  const session = (await sessionRef.get()).data();
  checkGrant(session, uid);
  const placeId = session!.placeId as string;

  // 이 쿼리 하나가 쿨다운과 첫 방문 여부를 함께 답한다 — 결과가 비어 있으면 첫 방문이다.
  const previous = await db
    .collection('tickets')
    .where('userId', '==', uid)
    .where('placeId', '==', placeId)
    .orderBy('issuedAt', 'desc')
    .limit(1)
    .get();
  const lastIssuedAt = (previous.docs[0]?.data().issuedAt as Timestamp | undefined)?.toDate();
  const firstVisit = !lastIssuedAt;
  if (lastIssuedAt) {
    const nextAvailableAt = cooldownEndsAt(lastIssuedAt);
    if (nextAvailableAt.getTime() > Date.now()) {
      throw precondition('cooldown_active', { nextAvailableAt: nextAvailableAt.toISOString() });
    }
  }

  // 경로 접두사를 보지 않으면 남의 사진 경로를 붙여 티켓을 만들 수 있다.
  if (!photoPath.startsWith(`tickets/${uid}/`)) {
    throw new HttpsError('invalid-argument', 'photoPath 가 본인 경로가 아니다');
  }
  const photoUrl = await downloadUrl(photoPath);

  const ticketRef = db.collection('tickets').doc();
  const userRef = db.doc(`users/${uid}`);
  const placeRef = db.doc(`places/${placeId}`);
  const serial = mintSerial(randomBytes(8));

  const { ticketBalance, tier } = await db.runTransaction(async (tx) => {
    const [sessionSnap, userSnap, placeSnap] = await Promise.all([
      tx.get(sessionRef), tx.get(userRef), tx.get(placeRef),
    ]);
    checkGrant(sessionSnap.data(), uid);
    const user = userSnap.data() ?? {};
    const ticketsIssued = ((user.ticketsIssued as number) ?? 0) + 1;
    const balance = ((user.ticketBalance as number) ?? 0) + 1;
    const nextTier = tierFor(ticketsIssued);
    const placeName = (placeSnap.data()?.name as Data | undefined)?.ko ?? '';
    const artistId = (placeSnap.data()?.artistIds as string[] | undefined)?.[0];

    tx.set(ticketRef, {
      userId: uid,
      placeId,
      placeName,
      photoUrl,
      serial,
      visibility,
      issuedAt: FieldValue.serverTimestamp(),
      spent: false,
      ...(artistId && { artistId }),
    });

    tx.set(
      userRef,
      {
        ticketBalance: balance,
        ticketsIssued,
        tier: nextTier,
        ...(firstVisit && { placesVisited: FieldValue.increment(1) }),
      },
      { merge: true },
    );

    tx.set(
      placeRef,
      {
        ticketCount: FieldValue.increment(1),
        photoCount: FieldValue.increment(1),
      },
      { merge: true },
    );

    // 갤러리는 인증을 통과한 사진만 모이는 벽이라 여기서만 쓴다.
    if (visibility === 'public') {
      tx.set(placeRef.collection('gallery').doc(), {
        ticketId: ticketRef.id,
        authorId: uid,
        photoUrl,
        createdAt: FieldValue.serverTimestamp(),
      });
    }

    tx.update(sessionRef, { status: 'consumed' });
    return { ticketBalance: balance, tier: nextTier };
  });

  return { ticketId: ticketRef.id, serial, ticketBalance, tier };
});

/** 그랜트가 이 호출자 것이고, 아직 살아 있고, 쓰이지 않았는가. */
function checkGrant(session: FirebaseFirestore.DocumentData | undefined, uid: string): void {
  if (!session || session.userId !== uid) throw precondition('grant_expired');
  if (session.status === 'consumed') throw precondition('grant_consumed');
  const grantExpiresAt = session.grantExpiresAt as Timestamp | undefined;
  if (session.status !== 'verified' || !grantExpiresAt || grantExpiresAt.toMillis() < Date.now()) {
    throw precondition('grant_expired');
  }
}

/**
 * 클라이언트 SDK 로 올린 파일에는 다운로드 토큰이 메타데이터에 붙는다. 없으면 하나 만들어
 * 붙인다 — 서명 URL 은 서비스 계정 키를 요구하고, 버킷을 공개로 여는 것은 더 나쁘다.
 */
async function downloadUrl(path: string): Promise<string> {
  const file = getStorage().bucket().file(path);
  const [exists] = await file.exists();
  if (!exists) throw new HttpsError('not-found', '사진이 없다');

  const [metadata] = await file.getMetadata();
  let token = metadata.metadata?.firebaseStorageDownloadTokens as string | undefined;
  if (!token) {
    token = randomUUID();
    await file.setMetadata({ metadata: { firebaseStorageDownloadTokens: token } });
  }
  const bucket = file.bucket.name;
  return `https://firebasestorage.googleapis.com/v0/b/${bucket}/o/${encodeURIComponent(path)}?alt=media&token=${token}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// enterRaffle
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 응모. 문서 id 가 곧 멱등 장치다 — {uid}_{raffleId}_{key} 에 문서가 이미 있으면 그 응모는
 * 일어난 것이므로 차감 없이 기존 id 를 돌려준다. 별도 멱등 컬렉션도 조회도 필요 없다.
 */
export const enterRaffle = onCall(async (req) => {
  const uid = requireUid(req);
  const data = (req.data ?? {}) as Data;
  const raffleId = str(data, 'raffleId');
  const idempotencyKey = str(data, 'idempotencyKey');
  if (!IDEMPOTENCY_KEY_RE.test(idempotencyKey)) {
    throw new HttpsError('invalid-argument', 'idempotencyKey 형식이 아니다');
  }

  const entryRef = db.doc(`raffleEntries/${uid}_${raffleId}_${idempotencyKey}`);
  const raffleRef = db.doc(`raffles/${raffleId}`);
  const userRef = db.doc(`users/${uid}`);

  return db.runTransaction(async (tx) => {
    const existing = await tx.get(entryRef);
    if (existing.exists) {
      const user = (await tx.get(userRef)).data() ?? {};
      const e = existing.data() ?? {};
      return {
        entryId: entryRef.id,
        ticketBalance: (user.ticketBalance as number) ?? 0,
        ticketIds: (e.ticketIds as string[]) ?? [],
        ticketsSpent: (e.ticketsSpent as number) ?? 0,
      };
    }

    const raffle = (await tx.get(raffleRef)).data();
    if (!raffle) throw new HttpsError('not-found', '없는 응모다');
    const closesAt = raffle.closesAt as Timestamp | undefined;
    if (raffle.status !== 'open' || (closesAt && closesAt.toMillis() < Date.now())) {
      throw new HttpsError('deadline-exceeded', '마감된 응모다');
    }
    const cost = (raffle.ticketCost as number) ?? 0;

    // 오래된 티켓부터 쓴다. 계약서에 순서 규정이 없어 사용자에게 유리한 쪽으로 정했다.
    const spendable = await tx.get(
      db
        .collection('tickets')
        .where('userId', '==', uid)
        .where('spent', '==', false)
        .orderBy('issuedAt', 'asc')
        .limit(cost),
    );
    if (spendable.size < cost) throw precondition('insufficient_tickets');

    const user = (await tx.get(userRef)).data() ?? {};
    const balance = ((user.ticketBalance as number) ?? 0) - cost;
    if (balance < 0) throw precondition('insufficient_tickets');

    const ticketIds = spendable.docs.map((d) => d.id);
    for (const d of spendable.docs) {
      tx.update(d.ref, { spent: true, spentOnEntryId: entryRef.id });
    }

    tx.set(entryRef, {
      userId: uid,
      raffleId,
      ticketIds,
      ticketsSpent: cost,
      createdAt: FieldValue.serverTimestamp(),
    });
    tx.update(userRef, { ticketBalance: balance });
    tx.update(raffleRef, { entryCount: FieldValue.increment(1) });

    return { entryId: entryRef.id, ticketBalance: balance, ticketIds, ticketsSpent: cost };
  });
});
