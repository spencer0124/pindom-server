import { randomBytes, randomUUID } from 'node:crypto';

import { initializeApp } from 'firebase-admin/app';
import { FieldValue, GeoPoint, Timestamp, getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import { setGlobalOptions } from 'firebase-functions';
import { defineSecret } from 'firebase-functions/params';
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
  normalizeBoard,
  tierFor,
  type LatLng,
} from './logic';
import {
  DAILY_CALL_LIMIT,
  KAKAO_CATEGORIES,
  MAX_MESSAGE_CHARS,
  MAX_TOOL_ROUNDS,
  SEARCH_TOOL,
  SYSTEM_PROMPT,
  type Route,
  type Suggestion,
  dayKeyKst,
  dedupe,
  nextCallCount,
  parseRoute,
  samplePath,
  sanitizeHistory,
  toSuggestion,
  waypoints,
} from './assistant';

// 키는 배포된 함수가 Secret Manager 에서 읽는다. .env.local 은 로컬 스크립트용이다.
const OPENAI_API_KEY = defineSecret('OPENAI_API_KEY');
const KAKAO_REST_API_KEY = defineSecret('KAKAO_REST_API_KEY');

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

  // 도착 검사는 세션의 첫 호출에서 한 번만 돈다. readings 가 비었는지로 판단하면 안 된다 —
  // mock·out_of_radius 거부도 readings 에 쌓이므로, 일부러 한 번 튕기면 이 검사가 통째로
  // 소모되고 이후 세션 전체가 300km/h 게이트 없이 지나간다. 어떤 거부보다 앞에 둬야
  // sessionId 없음 == 아직 안 돌았음 이 성립한다.
  if (!sessionId && (await jumpedFromLastTicket(uid, { lat, lng }, capturedAt))) {
    return reject('implausible_speed', true);
  }

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

// ─────────────────────────────────────────────────────────────────────────────
// askAssistant — Pindom AI
//
// 다른 함수들과 성격이 다르다. 남이 때리면 Firestore 읽기가 아니라 OpenAI 청구서가 나가고,
// 청구서에는 멈추는 쿼터가 없다. App Check 이 없는 동안 사용자당 일일 상한이 유일한 방어다.
// ─────────────────────────────────────────────────────────────────────────────

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}

/** 카카오 로컬. 429 는 던지지 않는다 — 추천이 비는 것이지 대화가 실패한 것은 아니다. */
async function searchNearby(
  args: Data,
  key: string,
  origin?: LatLng,
): Promise<{ places: Suggestion[]; note?: string }> {
  const lat = Number(args.lat);
  const lng = Number(args.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return { places: [], note: '좌표가 없다' };

  const radius = Math.min(Math.max(Number(args.radiusMeters) || 1_000, 100), 20_000);
  const category = KAKAO_CATEGORIES[args.category as keyof typeof KAKAO_CATEGORIES];
  const keyword = typeof args.keyword === 'string' ? args.keyword.slice(0, 50) : '';

  const url = new URL(
    keyword
      ? 'https://dapi.kakao.com/v2/local/search/keyword.json'
      : 'https://dapi.kakao.com/v2/local/search/category.json',
  );
  url.searchParams.set('x', String(lng));
  url.searchParams.set('y', String(lat));
  url.searchParams.set('radius', String(Math.round(radius)));
  url.searchParams.set('sort', 'distance');
  url.searchParams.set('size', '5');
  if (keyword) url.searchParams.set('query', keyword);
  if (category) url.searchParams.set('category_group_code', category);

  const res = await fetch(url, { headers: { Authorization: `KakaoAK ${key}` } });
  if (res.status === 429) return { places: [], note: '오늘 검색 한도를 다 썼다' };
  if (!res.ok) return { places: [], note: '검색에 실패했다' };

  const body = (await res.json()) as { documents?: Data[] };
  const places = (body.documents ?? [])
    .map((d) => toSuggestion(d, origin))
    .filter((s): s is Suggestion => s !== null);
  return { places };
}

/**
 * 카카오모빌리티 자동차 길찾기. 좌표는 x=경도, y=위도 로 보내고 vertexes 도 같은 순서로 온다.
 * 경로를 못 찾는 것은 흔한 일이라(섬, 도로 없는 지점) 던지지 않고 null 로 돌려준다.
 */
async function fetchRoute(
  origin: LatLng,
  destination: LatLng,
  stops: LatLng[],
  key: string,
): Promise<Route | null> {
  const res = await fetch('https://apis-navi.kakaomobility.com/v1/waypoints/directions', {
    method: 'POST',
    headers: { Authorization: `KakaoAK ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      origin: { x: origin.lng, y: origin.lat },
      destination: { x: destination.lng, y: destination.lat },
      // 경유지는 최대 30개다. 코스가 그보다 길면 앞에서 자른다.
      waypoints: stops.slice(0, 30).map((s) => ({ x: s.lng, y: s.lat })),
      priority: 'RECOMMEND',
    }),
  });
  if (!res.ok) return null;
  return parseRoute(await res.json());
}

/** 촬영지 문서에서 좌표를 읽는다. 클라이언트가 보낸 좌표는 판정에도 경로에도 쓰지 않는다. */
async function placeCoords(placeId: string): Promise<{ at: LatLng; name: string }> {
  const snap = await db.doc(`places/${placeId}`).get();
  const place = snap.data();
  if (!place) throw new HttpsError('not-found', `없는 장소다: ${placeId}`);
  return {
    at: geo(place.location as GeoPoint),
    name: String((place.name as Data | undefined)?.ko ?? '촬영지'),
  };
}

async function callOpenAI(messages: ChatMessage[], key: string): Promise<Data> {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages,
      tools: [SEARCH_TOOL],
      max_tokens: 600,
    }),
  });
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 200);
    throw new HttpsError('unavailable', `모델 호출 실패 (${res.status}): ${detail}`);
  }
  const body = (await res.json()) as { choices?: Array<{ message?: Data }> };
  const message = body.choices?.[0]?.message;
  if (!message) throw new HttpsError('unavailable', '모델이 빈 응답을 보냈다');
  return message;
}

export const askAssistant = onCall(
  { secrets: [OPENAI_API_KEY, KAKAO_REST_API_KEY], timeoutSeconds: 60 },
  async (req) => {
    const uid = requireUid(req);
    const data = (req.data ?? {}) as Data;
    const message = str(data, 'message').slice(0, MAX_MESSAGE_CHARS);

    // 상한 먼저. 모델을 부른 뒤에 세면 초과분이 이미 결제된 뒤다.
    const userRef = db.doc(`users/${uid}`);
    const today = dayKeyKst(new Date());
    const user = (await userRef.get()).data() ?? {};
    const count = nextCallCount(user.assistantCallDay, user.assistantCallCount, today);
    if (count > DAILY_CALL_LIMIT) {
      throw new HttpsError('resource-exhausted', '오늘 대화 한도를 다 썼다', {
        errorCode: 'assistant_daily_limit',
        limit: DAILY_CALL_LIMIT,
      });
    }
    await userRef.set({ assistantCallDay: today, assistantCallCount: count }, { merge: true });

    // 어디를 기준으로 찾을지. 좌표는 촬영지 문서에서 오고 클라이언트가 보낸 값을 쓰지 않는다.
    const near =
      typeof data.near === 'object' && data.near !== null
        ? ({ lat: num(data.near as Data, 'lat'), lng: num(data.near as Data, 'lng') } as LatLng)
        : undefined;

    let context = '';
    let route: Route | null = null;
    if (typeof data.towardPlaceId === 'string' && data.towardPlaceId !== '') {
      const target = await placeCoords(data.towardPlaceId);
      context = `사용자는 "${target.name}" (${target.at.lat}, ${target.at.lng}) 로 가는 중이다.`;
      if (near) {
        // 실제 도로 위에서 중간 지점을 잡는다. 직선으로 잡으면 바다나 산을 지나는 좌표가
        // 나오고, 그 주변을 검색하면 "가는 길에 들를 곳" 이 아닌 것이 추천된다.
        route = await fetchRoute(near, target.at, [], KAKAO_REST_API_KEY.value());
        const stops = route ? samplePath(route.path) : waypoints(near, target.at);
        const printed = stops.map((w) => `(${w.lat.toFixed(4)}, ${w.lng.toFixed(4)})`).join(', ');
        context += ` 출발지는 (${near.lat}, ${near.lng}) 이고,`;
        context += route
          ? ` 자동차로 약 ${Math.round(route.durationSeconds / 60)}분 걸린다.`
          : ' 경로를 찾지 못했다.';
        context += ` 가는 길의 중간 지점은 ${printed} 이다.`;
        context += ' 들를 곳을 물으면 중간 지점들과 목적지 주변을 각각 찾아본다.';
      }
    } else if (near) {
      context = `사용자의 현재 위치는 (${near.lat}, ${near.lng}) 이다.`;
    }

    const messages: ChatMessage[] = [
      { role: 'system', content: context ? `${SYSTEM_PROMPT}\n\n${context}` : SYSTEM_PROMPT },
      ...sanitizeHistory(data.history).map((m) => ({ role: m.role, content: m.content })),
      { role: 'user', content: message },
    ];

    const suggestions: Suggestion[] = [];
    let reply = '';

    for (let round = 0; round <= MAX_TOOL_ROUNDS; round += 1) {
      const answer = await callOpenAI(messages, OPENAI_API_KEY.value());
      const calls = (answer.tool_calls ?? []) as ChatMessage['tool_calls'];

      if (!calls || calls.length === 0 || round === MAX_TOOL_ROUNDS) {
        reply = typeof answer.content === 'string' ? answer.content : '';
        break;
      }

      messages.push(answer as unknown as ChatMessage);
      for (const call of calls) {
        let args: Data = {};
        try {
          args = JSON.parse(call.function.arguments) as Data;
        } catch {
          args = {};
        }
        const found = await searchNearby(args, KAKAO_REST_API_KEY.value(), near);
        suggestions.push(...found.places);
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify(found.note ? { note: found.note } : { places: found.places }),
        });
      }
    }

    // 경로를 이미 받아왔으면 함께 돌려준다. 앱이 지도에 선을 그리려고 다시 부를 이유가 없다.
    return { reply, suggestions: dedupe(suggestions).slice(0, 12), route };
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// saveBoard — 관리 도구 전용
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 게시판 생성·수정. boards 는 규칙에서 write: false 라 이 함수만 쓸 수 있고, 이 함수는
 * admin 커스텀 클레임이 있는 계정만 부를 수 있다. 클레임은
 * `npm --prefix functions run grant-admin` 으로 붙인다.
 *
 * 삭제는 없다. 게시글이 boardId 로 게시판을 가리키고 있어 문서를 지우면 그 글들이
 * 존재하지 않는 게시판에 매달린다. 목록에서 내리는 것은 archived 로 한다.
 */
export const saveBoard = onCall(async (req) => {
  requireUid(req);
  if (req.auth?.token.admin !== true) {
    throw new HttpsError('permission-denied', '관리자만 게시판을 바꿀 수 있다');
  }

  let boardId: string;
  let boardDoc: Record<string, unknown>;
  try {
    const normalized = normalizeBoard((req.data ?? {}) as Data);
    boardId = normalized.boardId;
    boardDoc = normalized.doc as unknown as Record<string, unknown>;
  } catch (e) {
    throw new HttpsError('invalid-argument', (e as Error).message);
  }

  // 아이돌 게시판은 id 가 artistId 다. 없는 아티스트로 만들면 앱이 게시판 헤더에 붙일
  // 이름도 색도 못 찾는다.
  if (boardDoc.kind === 'artist' && !(await db.doc(`artists/${boardId}`).get()).exists) {
    throw new HttpsError('not-found', `없는 아티스트다: ${boardId}`);
  }

  const ref = db.doc(`boards/${boardId}`);
  const existed = (await ref.get()).exists;
  await ref.set(
    { ...boardDoc, ...(existed ? {} : { createdAt: FieldValue.serverTimestamp() }) },
    { merge: true },
  );
  return { boardId, created: !existed };
});

// ─────────────────────────────────────────────────────────────────────────────
// getRoute — 코스를 지도에 선으로 그린다
//
// 촬영지 좌표는 서버가 읽는다. 코스 화면과 챗봇의 "지도에서 코스 보기" 가 같은 함수를 쓴다.
// ─────────────────────────────────────────────────────────────────────────────

export const getRoute = onCall({ secrets: [KAKAO_REST_API_KEY] }, async (req) => {
  requireUid(req);
  const data = (req.data ?? {}) as Data;

  const placeIds = Array.isArray(data.placeIds) ? data.placeIds.filter((v) => typeof v === 'string') : [];
  if (placeIds.length === 0) throw new HttpsError('invalid-argument', 'placeIds 가 비었다');

  const stops = await Promise.all((placeIds as string[]).map(placeCoords));

  // 출발지를 주면 거기서부터, 아니면 첫 촬영지에서 시작한다.
  const origin =
    typeof data.origin === 'object' && data.origin !== null
      ? ({ lat: num(data.origin as Data, 'lat'), lng: num(data.origin as Data, 'lng') } as LatLng)
      : (stops[0] as { at: LatLng }).at;
  const rest = data.origin ? stops : stops.slice(1);
  if (rest.length === 0) throw new HttpsError('invalid-argument', '출발지와 목적지가 같다');

  const destination = (rest[rest.length - 1] as { at: LatLng }).at;
  const via = rest.slice(0, -1).map((s) => s.at);

  const route = await fetchRoute(origin, destination, via, KAKAO_REST_API_KEY.value());
  if (!route) {
    throw new HttpsError('failed-precondition', '경로를 찾지 못했다', {
      errorCode: 'route_not_found',
    });
  }

  return { ...route, stops: stops.map((s, i) => ({ placeId: placeIds[i], name: s.name, ...s.at })) };
});
