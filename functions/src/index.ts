import { randomBytes, randomUUID } from 'node:crypto';

import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { FieldValue, GeoPoint, Timestamp, getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import { logger, setGlobalOptions } from 'firebase-functions';
import { defineBoolean, defineSecret } from 'firebase-functions/params';
import { HttpsError, onCall, type CallableRequest } from 'firebase-functions/v2/https';
import { onDocumentCreated, onDocumentUpdated, onDocumentWritten } from 'firebase-functions/v2/firestore';

import {
  ACCURACY_GATE_M,
  CLOCK_SKEW_MIN,
  DEFAULT_RADIUS_M,
  DOC_ID_RE,
  GRANT_TTL_MIN,
  IDEMPOTENCY_KEY_RE,
  MAX_READINGS,
  ROUTE_DAILY_LIMIT,
  SESSION_SPEED_KMH,
  TICKET_SPEED_KMH,
  VERIFY_DAILY_LIMIT,
  containsBanned,
  cooldownEndsAt,
  distanceMeters,
  effectiveDistance,
  isImplausibleJump,
  mintSerial,
  normalizeArtist,
  normalizeBoard,
  normalizePlace,
  tierFor,
  type LatLng,
} from './logic';
import {
  DAILY_CALL_LIMIT,
  GEOCODE_TOOL,
  KAKAO_CATEGORIES,
  ROUTE_TOOL,
  SPOTS_TOOL,
  MAX_MESSAGE_CHARS,
  SEARCH_TOOL,
  SYSTEM_PROMPT,
  type ChatMessage,
  type Route,
  type Suggestion,
  dayKeyKst,
  nearbySpots,
  nextCallCount,
  orderStops,
  parseRoute,
  runToolLoop,
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

/**
 * 로그인에 더해 이메일 인증까지 요구한다. 돈이 걸린 호출 — 남의 청구서(OpenAI)가 나가거나
 * 화폐(티켓)가 발행되는 자리 — 에만 붙인다.
 *
 * 이 백엔드의 비용 방어는 전부 uid 당으로 걸려 있다(AI 100회/일, 인증 200회/일, 쿨다운 30일).
 * 그런데 이메일·비밀번호 가입이 열려 있고 가입 쿼터도 없어서, uid 는 사실상 공짜다 —
 * 계정을 하나 더 만들면 모든 한도가 그대로 초기화된다. 한도를 아무리 조여도 그 위가 안
 * 막히면 소용이 없다.
 *
 * 진짜 해법은 App Check 이다(정품 앱에서 온 호출만 통과). 앱 쪽 SDK 작업이 선행돼야 해서
 * 서버만으로는 못 켜고, 그때까지 계정 양산 비용을 "받을 수 있는 메일 주소 하나" 로 올려
 * 두는 임시 방벽이다.
 *
 * 기본은 꺼져 있다. 앱이 가입 직후 sendEmailVerification() 을 보내기 전에 켜면 신규
 * 가입자가 전부 막힌다 — 서버만 먼저 켤 수 있는 종류의 방어가 아니다. 앱이 준비되면
 * `firebase deploy` 전에 functions/.env 의 REQUIRE_EMAIL_VERIFIED=true 로 바꾼다.
 */
const REQUIRE_EMAIL_VERIFIED = defineBoolean('REQUIRE_EMAIL_VERIFIED', { default: false });

function requireVerifiedUid(req: CallableRequest): string {
  const uid = requireUid(req);
  if (!REQUIRE_EMAIL_VERIFIED.value()) return uid;
  // 관리자는 통과시킨다 — grant-admin 으로 붙인 계정이고, 심사 계정이 메일 인증에 막혀
  // 데모가 멈추는 상황을 만들지 않기 위해서다.
  if (req.auth?.token.admin === true) return uid;
  if (req.auth?.token.email_verified !== true) {
    throw new HttpsError('permission-denied', '이메일 인증이 필요하다', {
      errorCode: 'email_not_verified',
    });
  }
  return uid;
}

function requireAdmin(req: CallableRequest): void {
  requireUid(req);
  if (req.auth?.token.admin !== true) {
    throw new HttpsError('permission-denied', '관리자만 할 수 있다');
  }
}

function str(data: Data, key: string): string {
  const v = data[key];
  if (typeof v !== 'string' || v === '') {
    throw new HttpsError('invalid-argument', `${key} 가 없거나 문자열이 아니다`);
  }
  return v;
}

/**
 * 문서 id 로 쓸 문자열. str 과 달리 글자를 따진다 — 슬래시가 통과하면
 * `places/${placeId}` 가 `places/a/reviews/b` 가 되어, 리뷰 문서를 장소 문서로
 * 읽거나 그 아래에 쓰게 된다. 경로를 조립하기 전이 유일하게 막을 수 있는 자리다.
 */
function docId(data: Data, key: string): string {
  const v = str(data, key);
  if (!DOC_ID_RE.test(v)) throw new HttpsError('invalid-argument', `${key} 가 올바른 id 가 아니다`);
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

/**
 * 사용자당 하루 호출 상한을 하나 소비한다. 넘으면 resource-exhausted 로 던진다.
 *
 * 읽기·검사·쓰기를 트랜잭션으로 묶는다 — 아니면 동시에 날아온 요청들이 전부 같은 count 를
 * 읽고 전부 통과해, 상한이 사실상 "동시 요청 수 × 한도" 가 된다.
 *
 * 카운터를 users/{uid} 가 아니라 rateLimits/{uid} 에 둔다. 두 가지 이유다:
 *
 *   1. 경합. verifyLocation 은 GPS 체크인 한 번에 여러 번 불린다. 카운터가 users 문서에
 *      있으면 그 연타가 issueTicket 의 ticketBalance·tier 쓰기와 같은 문서를 놓고 다투고,
 *      Firestore 는 문서 하나당 지속 쓰기가 초당 1회 남짓이라 체크인이 눈에 띄게 느려진다.
 *   2. 규칙. users 는 클라이언트가 만드는 문서라, 서버 전용 필드를 거기 두면 가입 요청에
 *      assistantCallCount: -1000000 을 끼워 넣는 우회를 규칙에서 필드마다 막아야 한다.
 *      아예 클라이언트가 닿을 수 없는 컬렉션으로 옮기면 그 방어가 통째로 필요 없어진다.
 */
async function consumeDailyQuota(
  uid: string,
  field: 'verify' | 'assistant' | 'route',
  limit: number,
  errorCode: string,
  message: string,
): Promise<void> {
  const ref = db.doc(`rateLimits/${uid}`);
  const today = dayKeyKst(new Date());
  const dayKey = `${field}Day`;
  const countKey = `${field}Count`;

  await db.runTransaction(async (tx) => {
    const data = (await tx.get(ref)).data() ?? {};
    const count = nextCallCount(data[dayKey], data[countKey], today);
    if (count > limit) {
      throw new HttpsError('resource-exhausted', message, { errorCode, limit });
    }
    tx.set(ref, { [dayKey]: today, [countKey]: count }, { merge: true });
  });
}

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
 *
 * minInstances 는 일부러 안 둔다. 상시 과금이라 콜드 스타트가 문제되는 건 공모전 데모
 * 순간뿐이다 — 데모 직전에만 켠다.
 */
export const verifyLocation = onCall(async (req) => {
  const uid = requireVerifiedUid(req);
  const data = (req.data ?? {}) as Data;

  // 상한 먼저. 세션 문서는 실패해도 생기고 verifyCount 는 성공할 때마다 늘어서,
  // 이걸 안 막으면 반복 호출만으로 둘 다 무한히 부풀릴 수 있다.
  await consumeDailyQuota(
    uid, 'verify', VERIFY_DAILY_LIMIT, 'verify_daily_limit', '오늘 인증 시도 한도를 다 썼다',
  );

  const placeId = docId(data, 'placeId');
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
  const sessionId = typeof data.sessionId === 'string' ? docId(data, 'sessionId') : undefined;

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
  let arrivalChecked = false;
  if (sessionId) {
    const snap = await sessionRef.get();
    const session = snap.data();
    if (!session) throw new HttpsError('not-found', '없는 세션이다');
    if (session.userId !== uid) throw new HttpsError('permission-denied', '남의 세션이다');
    if (session.placeId !== placeId) {
      throw new HttpsError('invalid-argument', '세션의 장소와 다르다');
    }
    readings = (session.readings as Reading[] | undefined) ?? [];
    arrivalChecked = session.arrivalChecked === true;
  }

  // 도착 검사(직전 티켓에서 여기까지 낼 수 있는 속도인가)는 세션당 정확히 한 번만 세운다.
  // isMock·poor_accuracy·out_of_radius 로 먼저 거부되는 호출에서 계산해 버리면, 그 결과를
  // 쓰지도 않은 채 arrivalChecked 만 true 로 남아 실제 속도 검사가 영원히 건너뛰어진다 —
  // 세션 문서를 만들면서 sessionId 를 돌려주므로 공격자는 accuracy 를 일부러 나쁘게 보내
  // "체크됨" 도장만 받고, 다음 호출에서 진짜 좌표로 검사를 피해 갈 수 있었다. 그래서 이
  // 검사는 그 결과가 실제로 최종 판정(거부든 통과든)을 결정하는 지점에서만 계산하고 세션에
  // 박는다 — 그 앞의 accuracy·radius·세션 내 속도 검사가 전부 통과한 뒤.
  const arrivalCheckedNow = !arrivalChecked;

  const reject = async (reason: string, append: boolean, checksArrival = false) => {
    await writeSession(
      sessionRef, uid, placeId, readings, append ? newReading() : undefined, null,
      checksArrival && arrivalCheckedNow,
    );
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

  // 앞의 accuracy·radius·세션 내 속도 검사를 전부 통과한 뒤에야 계산한다 — 여기 도달한
  // 호출만 이 판정을 최종 결과로 쓰고, arrivalChecked 도 이 시점에만 세션에 박힌다.
  const arrivalImplausible = arrivalCheckedNow && (await jumpedFromLastTicket(uid, { lat, lng }, capturedAt));
  if (arrivalImplausible) return reject('implausible_speed', true, true);

  const grantExpiresAt = Timestamp.fromMillis(Date.now() + GRANT_TTL_MIN * 60 * 1000);
  await Promise.all([
    writeSession(sessionRef, uid, placeId, readings, newReading(), grantExpiresAt, arrivalCheckedNow),
    // 장소/상세의 방문 인증 수. issueTicket 은 여기를 손대지 않는다 — 그랜트를 받고도
    // 티켓을 안 받을 수 있고, 이 숫자는 "여기 실제로 온 사람" 이지 발행 수가 아니다.
    placeSnap.ref.update({ verifyCount: FieldValue.increment(1) }),
  ]);

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
  arrivalChecked = false,
): Promise<void> {
  const readings = append ? [...existing, append].slice(-MAX_READINGS) : existing;
  const startedAt = Timestamp.now();
  await ref.set(
    {
      userId: uid,
      placeId,
      readings,
      // 이 판정이 실제로 도착 검사를 최종 결과로 썼을 때만 true 로 박는다 — 그래야 다음
      // 호출이 진짜로 건너뛰어도 되는지 안다. merge:true 라 false 일 땐 필드를 안 건드려
      // 기존에 세워진 true 를 실수로 되돌리지 않는다.
      ...(arrivalChecked && { arrivalChecked: true }),
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
  const uid = requireVerifiedUid(req);
  const data = (req.data ?? {}) as Data;
  const grantToken = docId(data, 'grantToken');
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

  // 경로 접두사를 보지 않으면 남의 사진 경로를 붙여 티켓을 만들 수 있다.
  if (!photoPath.startsWith(`tickets/${uid}/`)) {
    throw new HttpsError('invalid-argument', 'photoPath 가 본인 경로가 아니다');
  }
  const photoUrl = await downloadUrl(photoPath);

  const ticketRef = db.collection('tickets').doc();
  const userRef = db.doc(`users/${uid}`);
  const placeRef = db.doc(`places/${placeId}`);
  const serial = mintSerial(randomBytes(8));

  // 쿨다운·첫 방문 여부 쿼리도 트랜잭션 안에서 본다. 밖에서 보면 같은 장소에 그랜트
  // 두 개(각각 다른 세션)를 받아 issueTicket 을 동시에 두 번 불렀을 때, 둘 다 "이전 티켓
  // 없음" 을 보고 통과해 티켓 두 장과 placesVisited 이중 증가로 이어진다.
  const previousQuery = db
    .collection('tickets')
    .where('userId', '==', uid)
    .where('placeId', '==', placeId)
    .orderBy('issuedAt', 'desc')
    .limit(1);

  const { ticketBalance, tier } = await db.runTransaction(async (tx) => {
    const [sessionSnap, userSnap, placeSnap, previousSnap] = await Promise.all([
      tx.get(sessionRef), tx.get(userRef), tx.get(placeRef), tx.get(previousQuery),
    ]);
    checkGrant(sessionSnap.data(), uid);

    const lastIssuedAt = (previousSnap.docs[0]?.data().issuedAt as Timestamp | undefined)?.toDate();
    const firstVisit = !lastIssuedAt;
    if (lastIssuedAt) {
      const nextAvailableAt = cooldownEndsAt(lastIssuedAt);
      if (nextAvailableAt.getTime() > Date.now()) {
        throw precondition('cooldown_active', { nextAvailableAt: nextAvailableAt.toISOString() });
      }
    }

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
      photoPath,
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

    // 갤러리는 인증을 통과한 사진만 모이는 벽이라 여기서만 쓴다. 문서 id 를 티켓 id 와
    // 같게 두는 이유는 syncGalleryOnVisibility 가 쿼리 없이 바로 지우고 다시 쓰게 하기
    // 위해서다 — 티켓의 공개 여부가 나중에 바뀌어도 갤러리가 따라가야 한다.
    if (visibility === 'public') {
      tx.set(placeRef.collection('gallery').doc(ticketRef.id), {
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

/**
 * 토큰을 무조건 새로 갈아 끼운다. 다운로드 URL 은 Storage 규칙을 완전히 우회한다 —
 * 토큰이 곧 권한이라, 공개 기간에 URL 을 저장해 둔 사람은 비공개로 돌려도 계속 볼 수
 * 있다. syncGalleryOnVisibility 가 공개→비공개 전환에서 이 함수를 부른다.
 */
async function rotateDownloadUrl(path: string): Promise<string> {
  const file = getStorage().bucket().file(path);
  const token = randomUUID();
  await file.setMetadata({ metadata: { firebaseStorageDownloadTokens: token } });
  return `https://firebasestorage.googleapis.com/v0/b/${file.bucket.name}/o/${encodeURIComponent(path)}?alt=media&token=${token}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// enterRaffle
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 응모. 문서 id 가 곧 멱등 장치다 — {uid}_{raffleId}_{key} 에 문서가 이미 있으면 그 응모는
 * 일어난 것이므로 차감 없이 기존 id 를 돌려준다. 별도 멱등 컬렉션도 조회도 필요 없다.
 */
export const enterRaffle = onCall(async (req) => {
  const uid = requireVerifiedUid(req);
  const data = (req.data ?? {}) as Data;
  const raffleId = docId(data, 'raffleId');
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
    // entryCount 는 여기서 올리지 않는다 — countRaffleEntry 트리거가 맡는다. 이유는 그 함수 주석에.

    return { entryId: entryRef.id, ticketBalance: balance, ticketIds, ticketsSpent: cost };
  });
});

/**
 * 응모 수 집계. enterRaffle 트랜잭션 밖으로 뺀 이유:
 *
 * 래플은 본질적으로 스탬피드다 — "응모 시작" 이 뜨면 전원이 동시에 누른다. 그런데
 * raffles/{raffleId} 는 응모자 전원이 공유하는 문서 하나고, Firestore 는 문서 하나당
 * 지속 쓰기가 초당 1회 남짓이다. 이 증가를 트랜잭션 안에 두면 동시 응모자들이 같은 문서를
 * 놓고 경합해 트랜잭션이 ABORTED 로 죽고, 죽을 때마다 읽기 네 번(티켓 쿼리 포함)이 통째로
 * 다시 돈다. 사용자에게는 "응모 실패" 로 보인다 — 티켓은 멀쩡한데 응모가 안 되는 상태다.
 *
 * 응모는 반드시 성공해야 하고 숫자는 좀 늦어도 된다. 그래서 순서를 바꿨다.
 *
 * ponytail: 트리거도 결국 같은 문서에 쓰므로 초당 1회 한계는 그대로다. 다만 밀리는 게
 * 사용자 요청이 아니라 집계라 응모가 실패하지 않는다. 트리거는 at-least-once 라 아주
 * 드물게 재시도로 한두 개 더 셀 수 있다. 정확한 수가 필요해지면(당첨자 추첨 등) 그 값을
 * 믿지 말고 raffleEntries.where('raffleId','==',id).count() 집계 쿼리로 세면 된다.
 */
export const countRaffleEntry = onDocumentCreated('raffleEntries/{entryId}', async (event) => {
  const raffleId = event.data?.data().raffleId as string | undefined;
  if (!raffleId) return;
  await db.doc(`raffles/${raffleId}`).update({ entryCount: FieldValue.increment(1) });
});

// ─────────────────────────────────────────────────────────────────────────────
// askAssistant — Pindom AI
//
// 다른 함수들과 성격이 다르다. 남이 때리면 Firestore 읽기가 아니라 OpenAI 청구서가 나가고,
// 청구서에는 멈추는 쿼터가 없다. App Check 이 없는 동안 사용자당 일일 상한이 유일한 방어다.
// ─────────────────────────────────────────────────────────────────────────────

/** 카카오 로컬. 429 는 던지지 않는다 — 추천이 비는 것이지 대화가 실패한 것은 아니다. */
async function searchNearby(
  args: Data,
  key: string,
  origin?: LatLng,
): Promise<{ places: Suggestion[]; note?: string }> {
  const center = coordArg(args) ?? origin;
  if (!center) return { places: [], note: '좌표가 없다' };
  const { lat, lng } = center;

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
    .map((d) => toSuggestion(d, center))
    .filter((s): s is Suggestion => s !== null);
  return { places };
}

/**
 * 지명 → 좌표. 사용자가 GPS 좌표 없이 "강남역" 처럼 텍스트로만 위치를 말했을 때 모델이
 * 이 도구로 먼저 좌표를 구하고, 그 결과를 search_nearby 에 이어 붙인다 — 모델이 위치를
 * 다시 되묻는 대신 도구 체인으로 스스로 채우게 하는 게 이 함수의 유일한 존재 이유다.
 */
async function geocodePlace(query: string, key: string): Promise<{ note: string } | { lat: number; lng: number; name: string }> {
  const url = new URL('https://dapi.kakao.com/v2/local/search/keyword.json');
  url.searchParams.set('query', query);
  url.searchParams.set('size', '1');

  const res = await fetch(url, { headers: { Authorization: `KakaoAK ${key}` } });
  if (!res.ok) return { note: '검색에 실패했다' };

  const body = (await res.json()) as { documents?: Data[] };
  const d = body.documents?.[0];
  if (!d) return { note: `"${query}" 를 찾지 못했다` };

  return { lat: Number(d.y), lng: Number(d.x), name: String(d.place_name ?? query) };
}

/** 카카오모빌리티가 105/106 으로 거절했을 때, 그 지점을 옆으로 옮겨 재시도하는 폭 — 약 25m. */
const NUDGE_LAT = 25 / 111_320;
const NUDGE_LNG = 25 / 88_800; // 서울 위도(약 37.5˚)에서 경도 1도의 실거리로 나눈 근사치

/** 인증 좌표(예: 보행교 위)가 카카오모빌리티엔 "도로 없음"으로 보일 때 시도할 네 방향. */
const NUDGES: LatLng[] = [
  { lat: NUDGE_LAT, lng: 0 },
  { lat: -NUDGE_LAT, lng: 0 },
  { lat: 0, lng: NUDGE_LNG },
  { lat: 0, lng: -NUDGE_LNG },
];

function nudged(p: LatLng, d: LatLng): LatLng {
  return { lat: p.lat + d.lat, lng: p.lng + d.lng };
}

/** 한 번의 카카오모빌리티 호출. 결과와 함께 result_code 도 돌려줘 재시도 여부를 판단하게 한다. */
async function requestRoute(
  origin: LatLng,
  destination: LatLng,
  stops: LatLng[],
  key: string,
): Promise<{ route: Route | null; resultCode: number | null }> {
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
  if (!res.ok) return { route: null, resultCode: null };
  const body = (await res.json()) as { routes?: Array<{ result_code?: unknown }> };
  const code = Number(body.routes?.[0]?.result_code);
  return { route: parseRoute(body), resultCode: Number.isFinite(code) ? code : null };
}

/**
 * 카카오모빌리티 자동차 길찾기. 좌표는 x=경도, y=위도 로 보내고 vertexes 도 같은 순서로 온다.
 * 경로를 못 찾는 것은 흔한 일이라(섬, 도로 없는 지점) 던지지 않고 null 로 돌려준다.
 *
 * 인증 좌표는 GPS 인증 반경의 기준점이라(backend-contract.md) 실제 촬영지 그 자리를 가리켜야
 * 하고, 그게 꼭 차량이 들어가는 도로 위는 아니다(보행교, 광장 등). 105/106(출발·도착지 주변
 * 도로에 유고 정보)은 바로 그 증상이라, 좌표를 바꾸는 대신 요청에서만 그 지점을 살짝 옆으로
 * 옮겨 다시 물어본다 — 저장된 좌표에는 손대지 않는다.
 */
async function fetchRoute(
  origin: LatLng,
  destination: LatLng,
  stops: LatLng[],
  key: string,
): Promise<Route | null> {
  let tryOrigin = origin;
  let tryDestination = destination;
  for (let attempt = 0; attempt <= NUDGES.length; attempt += 1) {
    const { route, resultCode } = await requestRoute(tryOrigin, tryDestination, stops, key);
    if (route) return route;
    // 105/106 이 아니면(예: 애초에 너무 멀다) 옮겨봐야 소용없다.
    if (resultCode !== 105 && resultCode !== 106) return null;
    if (attempt === NUDGES.length) {
      console.warn('fetchRoute: 105/106 을 재시도로도 못 피했다', { origin, destination, resultCode });
      return null;
    }
    const d = NUDGES[attempt] as LatLng;
    if (resultCode === 105) tryOrigin = nudged(origin, d);
    else tryDestination = nudged(destination, d);
  }
  return null;
}

/** 촬영지 문서에서 좌표를 읽는다. 클라이언트가 보낸 좌표는 판정에도 경로에도 쓰지 않는다. */
async function placeCoords(placeId: string): Promise<{ at: LatLng; name: string }> {
  // getRoute 의 목록, 챗봇의 towardPlaceId, 모델이 채운 plan_route 인자가 모두 이리로
  // 모인다. 셋을 따로 검사하는 대신 경로를 만드는 이 한 자리에서 막는다.
  if (!DOC_ID_RE.test(placeId)) throw new HttpsError('invalid-argument', `올바른 장소 id 가 아니다: ${placeId}`);
  const snap = await db.doc(`places/${placeId}`).get();
  const place = snap.data();
  if (!place) throw new HttpsError('not-found', `없는 장소다: ${placeId}`);
  return {
    at: geo(place.location as GeoPoint),
    name: String((place.name as Data | undefined)?.ko ?? '촬영지'),
  };
}

/**
 * 답변이 가리키는 촬영지. 모델은 이름과 거리를 읽고, 앱은 좌표로 지도에 핀을 찍는다.
 * 같은 목록이 두 곳에 쓰이므로 도구 결과와 응답이 갈라지지 않는다.
 */
interface Spot {
  placeId: string;
  name: string;
  lat: number;
  lng: number;
  region?: string;
  workTitle?: string;
  distanceMeters?: number;
}

/** A "nearby" answer must not surface a distant city just because the roster is small. */
const NEARBY_FILMING_RADIUS_M = 100_000;

/** 도구 인자로 온 좌표. 둘 다 성해야 좌표다 — 하나만 오면 없는 것으로 친다. */
function coordArg(args: Data, latKey = 'lat', lngKey = 'lng'): LatLng | undefined {
  const lat = Number(args[latKey]);
  const lng = Number(args[lngKey]);
  return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : undefined;
}

/**
 * 등록된 촬영지. 모델이 "촬영지가 없다" 고 답하기 전에 반드시 거치는 자리다 —
 * 카카오 검색(search_nearby)은 카페와 관광지를 알 뿐 우리 촬영지는 모른다.
 *
 * 아이돌 이름은 사용자가 말한 그대로 오므로 artists 를 훑어 id 로 바꾼다. 로스터가
 * 작아서 전체 읽기로 충분하다 — places.search 가 앱에서 이미 같은 방식이다.
 */
async function findFilmingSpots(
  args: Data,
  near?: LatLng,
  restrictToOrigin = false,
): Promise<{ result: Data; spots?: Spot[] }> {
  const artist = typeof args.artist === 'string' ? args.artist.trim() : '';
  let artistId = '';
  if (artist) {
    const roster = await db.collection('artists').get();
    const hit = roster.docs.find((d) => {
      const name = d.data().name as Data | undefined;
      return (
        String(name?.ko ?? '') === artist
        || String(name?.en ?? '').toLowerCase() === artist.toLowerCase()
      );
    });
    if (!hit) return { result: { note: `"${artist}" 는 등록된 아이돌이 아니다` } };
    artistId = hit.id;
  }

  const query = artistId
    ? db.collection('places').where('artistIds', 'array-contains', artistId)
    : db.collection('places');
  const snap = await query.get();

  const origin = coordArg(args) ?? near;
  const spots: Spot[] = snap.docs
    .map((d) => {
      const place = d.data();
      const at = geo(place.location as GeoPoint);
      return {
        placeId: d.id,
        name: String((place.name as Data | undefined)?.ko ?? '촬영지'),
        region: String((place.region as Data | undefined)?.ko ?? ''),
        workTitle: String((place.workTitle as Data | undefined)?.ko ?? ''),
        lat: at.lat,
        lng: at.lng,
        ...(origin && { distanceMeters: Math.round(distanceMeters(origin, at)) }),
      };
    })
    .sort((a, b) => (a.distanceMeters ?? 0) - (b.distanceMeters ?? 0));

  const nearby = nearbySpots(spots, Boolean(origin), Boolean(artistId));
  const local = origin && (!artistId || restrictToOrigin || coordArg(args) != null)
    ? nearby.filter((spot) => (spot.distanceMeters ?? Infinity) <= NEARBY_FILMING_RADIUS_M)
    : nearby;
  return local.length === 0
    ? { result: { note: '등록된 촬영지가 없다' } }
    : { result: { spots: local }, spots: local };
}

/**
 * 들를 순서와 이동 시간. 순서는 우리가 잡는다 — 모델이 좌표를 눈으로 훑어 정하면
 * 서울과 부산이 번갈아 나오는 동선이 나온다.
 */
async function planRoute(
  args: Data,
  near: LatLng | undefined,
  key: string,
): Promise<{ result: Data; route?: Route; spots?: Spot[] }> {
  const placeIds = (Array.isArray(args.placeIds) ? args.placeIds : [])
    .filter((v): v is string => typeof v === 'string')
    .slice(0, 10);
  if (placeIds.length === 0) return { result: { note: 'placeIds 가 없다' } };

  const found = await Promise.all(placeIds.map(placeCoords));
  const stops = found.map((s, i) => ({ ...s, placeId: placeIds[i] as string }));
  const origin = coordArg(args, 'originLat', 'originLng') ?? near;
  const ordered = orderStops(origin ?? (stops[0] as { at: LatLng }).at, stops);
  const order = ordered.map((s) => s.name);
  const spots: Spot[] = ordered.map((s) => ({ placeId: s.placeId, name: s.name, lat: s.at.lat, lng: s.at.lng }));

  // 출발지가 없고 목적지도 하나뿐이면 그릴 구간이 없다. 이동 시간 없이 그것만 돌려준다.
  const from = origin ?? (ordered[0] as { at: LatLng }).at;
  const rest = origin ? ordered : ordered.slice(1);
  if (rest.length === 0) {
    return { result: { order, note: '출발지를 알려주면 이동 시간까지 계산할 수 있다' }, spots };
  }

  const last = rest[rest.length - 1] as { at: LatLng };
  const drawn = await fetchRoute(from, last.at, rest.slice(0, -1).map((s) => s.at), key);
  if (!drawn) return { result: { order, note: '경로를 찾지 못했다' }, spots };

  return {
    route: drawn,
    spots,
    result: {
      order,
      totalMinutes: Math.round(drawn.durationSeconds / 60),
      totalKilometers: Math.round(drawn.distanceMeters / 100) / 10,
    },
  };
}

async function routeCourseId(artistId: unknown, spots: Spot[]): Promise<string | undefined> {
  if (spots.length < 2) return undefined;
  const ids = new Set(spots.map((spot) => spot.placeId));
  try {
    const snap = typeof artistId === 'string' && artistId !== ''
      ? await db.collection('courses').where('artistId', '==', artistId).get()
      : await db.collection('courses').get();
    return snap.docs.find((doc) => {
      const placeIds = doc.data().placeIds;
      return Array.isArray(placeIds)
        && placeIds.length === ids.size
        && placeIds.every((id) => typeof id === 'string' && ids.has(id));
    })?.id;
  } catch (err) {
    // courseId 는 덤이라 실패해도 답변은 나가야 한다. 다만 조용히 삼키면 규칙·색인
    // 문제로 영영 안 붙는 것을 눈치챌 데가 없어서 로그는 남긴다.
    logger.warn('routeCourseId 조회 실패', err);
    return undefined;
  }
}

async function callOpenAI(messages: ChatMessage[], key: string): Promise<ChatMessage> {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages,
      tools: [SPOTS_TOOL, ROUTE_TOOL, SEARCH_TOOL, GEOCODE_TOOL],
      max_tokens: 600,
    }),
  });
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 200);
    throw new HttpsError('unavailable', `모델 호출 실패 (${res.status}): ${detail}`);
  }
  const body = (await res.json()) as { choices?: Array<{ message?: ChatMessage }> };
  const message = body.choices?.[0]?.message;
  if (!message) throw new HttpsError('unavailable', '모델이 빈 응답을 보냈다');
  return message;
}

export const askAssistant = onCall(
  { secrets: [OPENAI_API_KEY, KAKAO_REST_API_KEY], timeoutSeconds: 60 },
  async (req) => {
    const uid = requireVerifiedUid(req);
    const data = (req.data ?? {}) as Data;
    const message = str(data, 'message').slice(0, MAX_MESSAGE_CHARS);

    // 상한 먼저. 모델을 부른 뒤에 세면 초과분이 이미 결제된 뒤다.
    await consumeDailyQuota(
      uid, 'assistant', DAILY_CALL_LIMIT, 'assistant_daily_limit', '오늘 대화 한도를 다 썼다',
    );

    // 어디를 기준으로 찾을지. 좌표는 촬영지 문서에서 오고 클라이언트가 보낸 값을 쓰지 않는다.
    const near =
      typeof data.near === 'object' && data.near !== null
        ? ({ lat: num(data.near as Data, 'lat'), lng: num(data.near as Data, 'lng') } as LatLng)
        : undefined;

    let context = '';
    // A geocoded place is the user's requested search center, not just context
    // for the model. Keep it for the following tool call so 부산 cannot fall
    // back to the device's current 서울 coordinates.
    let searchNear = near;
    let searchNearIsExplicit = false;
    let route: Route | null = null;
    // 답변이 가리키는 촬영지와, 그 순서가 동선인지. 앱은 이걸로 대화 안에 지도를 그린다.
    let spots: Spot[] = [];
    let ordered = false;

    // 앱은 사용자가 고른 최애를 함께 보낸다. 이름을 미리 붙여 두면 "우리 애 촬영지" 처럼
    // 이름 없이 물어도 find_filming_spots 의 artist 인자를 모델이 채울 수 있다.
    if (typeof data.artistId === 'string' && data.artistId !== '') {
      const artist = (await db.doc(`artists/${docId(data, 'artistId')}`).get()).data();
      const name = (artist?.name as Data | undefined)?.ko;
      if (typeof name === 'string') context = `사용자의 최애는 "${name}" 이다.`;
    }
    if (typeof data.towardPlaceId === 'string' && data.towardPlaceId !== '') {
      const target = await placeCoords(data.towardPlaceId);
      context += ` 사용자는 "${target.name}" (${target.at.lat}, ${target.at.lng}) 로 가는 중이다.`;
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
      context += ` 사용자의 현재 위치는 (${near.lat}, ${near.lng}) 이다.`;
    }

    const messages: ChatMessage[] = [
      { role: 'system', content: context ? `${SYSTEM_PROMPT}\n\n${context}` : SYSTEM_PROMPT },
      ...sanitizeHistory(data.history).map((m) => ({ role: m.role, content: m.content })),
      { role: 'user', content: message },
    ];

    // 어느 도구를 불렀든 결과는 다음 라운드의 tool 메시지로 들어간다 — 모델이 그 좌표를
    // 받아 곧바로 search_nearby 를 다시 부르는 것까지가 한 대화의 정상 경로다. 루프 자체는
    // runToolLoop(assistant.ts) 가 갖고, 여기서는 실제 도구 구현만 주입한다.
    const { reply, suggestions } = await runToolLoop(
      messages,
      (msgs) => callOpenAI(msgs, OPENAI_API_KEY.value()),
      async (name, args) => {
        if (name === 'find_filming_spots') {
          const found = await findFilmingSpots(args, searchNear, searchNearIsExplicit);
          if (found.spots) spots = found.spots;
          return found.result;
        }
        if (name === 'plan_route') {
          const planned = await planRoute(args, searchNear, KAKAO_REST_API_KEY.value());
          // 경로 좌표는 모델에게 보내지 않는다 — 600점짜리 배열이고 모델은 쓸 데가 없다.
          // 앱이 지도에 선을 그릴 수 있게 응답에만 싣는다.
          if (planned.route) route = planned.route;
          // 순서가 정해진 뒤로는 이쪽이 앱이 찍을 핀이다 — 번호가 동선 순서가 된다.
          if (planned.spots) {
            spots = planned.spots;
            ordered = true;
          }
          return planned.result;
        }
        if (name === 'geocode_place') {
          const query = typeof args.query === 'string' ? args.query : '';
          if (!query) return { note: '지명이 없다' };
          const found = await geocodePlace(query, KAKAO_REST_API_KEY.value());
          if ('lat' in found && 'lng' in found) {
            searchNear = { lat: found.lat, lng: found.lng };
            searchNearIsExplicit = true;
          }
          return found;
        }
        const found = await searchNearby(args, KAKAO_REST_API_KEY.value(), searchNear);
        return found.note ? { note: found.note } : { places: found.places };
      },
    );

    // 경로를 이미 받아왔으면 함께 돌려준다. 앱이 지도에 선을 그리려고 다시 부를 이유가 없다.
    const courseId = ordered ? await routeCourseId(data.artistId, spots) : undefined;
    return { reply, suggestions, route, spots, ordered, ...(courseId && { courseId }) };
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
 * 삭제는 `deleteBoard` 가 한다 — 게시글이 있으면 거부한다. 게시글 없이 그냥
 * 내려두고 싶으면 archived 를 쓴다.
 */
export const saveBoard = onCall(async (req) => {
  requireAdmin(req);

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
// saveArtist — 관리 도구 전용
// ─────────────────────────────────────────────────────────────────────────────

/** 아티스트 생성·수정. 삭제는 `deleteArtist` 가 한다 — 게시판이나 촬영지가 딸려 있으면 거부한다. */
export const saveArtist = onCall(async (req) => {
  requireAdmin(req);

  let artistId: string;
  let artistDoc: Record<string, unknown>;
  try {
    const normalized = normalizeArtist((req.data ?? {}) as Data);
    artistId = normalized.artistId;
    artistDoc = normalized.doc as unknown as Record<string, unknown>;
  } catch (e) {
    throw new HttpsError('invalid-argument', (e as Error).message);
  }

  const ref = db.doc(`artists/${artistId}`);
  const existed = (await ref.get()).exists;
  await ref.set(artistDoc, { merge: true });
  return { artistId, created: !existed };
});

// ─────────────────────────────────────────────────────────────────────────────
// savePlace — 관리 도구 전용
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 촬영지(티켓 발급 장소) 생성·수정. placeId 를 보내면 그 문서를 고치고, 안 보내면
 * 새로 만든다 — TourAPI 적재본과 달리 auto id 로 충분하다. 삭제 없음 — tickets 가
 * placeId 로 가리킨다.
 */
export const savePlace = onCall(async (req) => {
  requireAdmin(req);

  let placeId: string | undefined;
  let placeDoc: Record<string, unknown>;
  try {
    const normalized = normalizePlace((req.data ?? {}) as Data);
    placeId = normalized.placeId;
    placeDoc = normalized.doc as unknown as Record<string, unknown>;
  } catch (e) {
    throw new HttpsError('invalid-argument', (e as Error).message);
  }

  const artistIds = placeDoc.artistIds as string[];
  if (artistIds.length > 0) {
    const snaps = await db.getAll(...artistIds.map((id) => db.doc(`artists/${id}`)));
    const missing = snaps.filter((s) => !s.exists).map((s) => s.id);
    if (missing.length > 0) throw new HttpsError('not-found', `없는 아티스트다: ${missing.join(', ')}`);
  }

  const { lat, lng, ...rest } = placeDoc as { lat: number; lng: number; [k: string]: unknown };
  const ref = placeId ? db.doc(`places/${placeId}`) : db.collection('places').doc();
  const existed = placeId ? (await ref.get()).exists : false;
  if (placeId && !existed) throw new HttpsError('not-found', `없는 장소다: ${placeId}`);
  await ref.set(
    { ...rest, location: new GeoPoint(lat, lng), ...(existed ? {} : { createdAt: FieldValue.serverTimestamp() }) },
    { merge: true },
  );
  return { placeId: ref.id, created: !existed };
});

// ─────────────────────────────────────────────────────────────────────────────
// deleteBoard / deleteArtist — 관리 도구 전용
//
// 참조가 하나라도 있으면 거부한다. 연쇄 삭제는 안 한다 — 티켓·글 이력을 같이
// 지우는 건 되돌릴 수 없고, 이 함수가 조용히 결정할 일이 아니다.
// ─────────────────────────────────────────────────────────────────────────────

export const deleteBoard = onCall(async (req) => {
  requireAdmin(req);
  const boardId = docId((req.data ?? {}) as Data, 'boardId');

  const postSnap = await db.collection('posts').where('boardId', '==', boardId).limit(1).get();
  if (!postSnap.empty) {
    throw new HttpsError('failed-precondition', `게시글이 있는 게시판은 못 지운다: ${boardId}`);
  }

  const ref = db.doc(`boards/${boardId}`);
  if (!(await ref.get()).exists) throw new HttpsError('not-found', `없는 게시판이다: ${boardId}`);
  await ref.delete();
  return { boardId };
});

export const deleteArtist = onCall(async (req) => {
  requireAdmin(req);
  const artistId = docId((req.data ?? {}) as Data, 'artistId');

  const [boardSnap, placeSnap, courseSnap] = await Promise.all([
    db.doc(`boards/${artistId}`).get(),
    db.collection('places').where('artistIds', 'array-contains', artistId).limit(1).get(),
    db.collection('courses').where('artistId', '==', artistId).limit(1).get(),
  ]);
  if (boardSnap.exists) {
    throw new HttpsError('failed-precondition', `게시판이 딸린 아티스트는 못 지운다: ${artistId}`);
  }
  if (!placeSnap.empty) {
    throw new HttpsError('failed-precondition', `촬영지가 연결된 아티스트는 못 지운다: ${artistId}`);
  }
  if (!courseSnap.empty) {
    throw new HttpsError('failed-precondition', `코스가 딸린 아티스트는 못 지운다: ${artistId}`);
  }

  const ref = db.doc(`artists/${artistId}`);
  if (!(await ref.get()).exists) throw new HttpsError('not-found', `없는 아티스트다: ${artistId}`);
  await ref.delete();
  return { artistId };
});

// ─────────────────────────────────────────────────────────────────────────────
// getRoute — 코스를 지도에 선으로 그린다
//
// 촬영지 좌표는 서버가 읽는다. 코스 화면과 챗봇의 "지도에서 코스 보기" 가 같은 함수를 쓴다.
// ─────────────────────────────────────────────────────────────────────────────

export const getRoute = onCall({ secrets: [KAKAO_REST_API_KEY] }, async (req) => {
  const uid = requireVerifiedUid(req);
  await consumeDailyQuota(
    uid, 'route', ROUTE_DAILY_LIMIT, 'route_daily_limit', '오늘 길찾기 한도를 다 썼다',
  );
  const data = (req.data ?? {}) as Data;

  const placeIds = Array.isArray(data.placeIds) ? data.placeIds.filter((v) => typeof v === 'string') : [];
  if (placeIds.length === 0) throw new HttpsError('invalid-argument', 'placeIds 가 비었다');
  // fetchRoute 는 경유지를 30개로 자르지만, 자르기 전에 이미 읽기가 다 끝난 뒤다.
  // 상한 없이 두면 호출 한 번으로 placeIds 개수만큼 Firestore 읽기가 나간다.
  if (placeIds.length > 30) throw new HttpsError('invalid-argument', 'placeIds 는 최대 30개다');

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

// ─────────────────────────────────────────────────────────────────────────────
// syncGalleryOnVisibility — 갤러리가 티켓의 공개 여부를 따라가게 한다
// ─────────────────────────────────────────────────────────────────────────────

/**
 * issueTicket 은 공개 티켓만 갤러리에 적는다. 이후 사용자가 공개⇄비공개를 바꿔도 그때는
 * 갤러리를 손대지 않아서, 비공개로 내린 사진이 장소/상세에 계속 남고 공개로 올린 사진은
 * 영원히 나타나지 않았다. 갤러리 문서 id 를 티켓 id 와 같게 둬서(issueTicket 참고)
 * 쿼리 없이 존재 여부만으로 만들고 지운다.
 */
export const syncGalleryOnVisibility = onDocumentUpdated('tickets/{ticketId}', async (event) => {
  const before = event.data?.before.data();
  const after = event.data?.after.data();
  if (!before || !after || before.visibility === after.visibility) return;

  const galleryRef = db.doc(`places/${after.placeId}/gallery/${event.params.ticketId}`);
  if (after.visibility === 'public') {
    await galleryRef.set({
      ticketId: event.params.ticketId,
      authorId: after.userId,
      photoUrl: after.photoUrl,
      createdAt: FieldValue.serverTimestamp(),
    });
  } else {
    await galleryRef.delete();

    // 공개였던 동안 URL 을 저장해 둔 사람은 토큰을 안 갈면 비공개로 돌려도 계속 본다 —
    // 다운로드 URL 자체가 Storage 규칙을 우회하는 권한이라서다. photoPath 가 없는
    // 옛 티켓(이 필드를 넣기 전 발급분)은 건너뛴다 — 회전시킬 원본 경로를 모른다.
    const photoPath = after.photoPath as string | undefined;
    if (photoPath) {
      const photoUrl = await rotateDownloadUrl(photoPath);
      await event.data!.after.ref.update({ photoUrl });
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 금칙어 필터 — Apple 심사 가이드라인 1.2
//
// 규칙으로는 낱말 목록을 볼 수 없다 (정규식도 배열 순회도 없다). 그래서 트리거가 맡는다.
// create 만 보면 깨끗한 글을 올린 뒤 고쳐 넣는 우회가 그대로 열려 있어 update 도 본다.
//
// 되받는 방식은 삭제다. 숨김 필드로 두면 피드·갤러리 쿼리와 색인을 전부 고쳐야 하는데,
// 걸리는 글이 드문 데 비해 값이 너무 비싸다.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 걸린 글은 지우기 전에 원문을 통째로 moderationQueue 에 옮겨 둔다.
 *
 * 그냥 지우기만 하면 오검출이 곧 데이터 손실이다. containsBanned 는 공백·구두점을 지운 뒤
 * 부분 문자열로 보는 방식이라 낱말 경계를 넘는 오검출이 원리상 남아 있고, 걸린 사용자에게는
 * 글이 소리 없이 사라진 것으로만 보인다 — 문의가 와도 뭘 썼는지조차 확인할 수 없다.
 *
 * 큐에 원문을 남겨 두면 관리자가 콘솔에서 보고 되살릴 수 있고, 오검출이 쌓이면 그게 곧
 * BANNED_WORDS 를 다듬을 근거가 된다. 피드 쿼리·색인은 그대로 둔 채(문서는 여전히 사라지므로)
 * 복구 경로만 생긴다.
 */
async function moderate(
  snap: FirebaseFirestore.DocumentSnapshot | undefined,
  fields: string[],
): Promise<void> {
  const data = snap?.data();
  if (!data) return;
  const text = fields.map((f) => (typeof data[f] === 'string' ? (data[f] as string) : '')).join(' ');
  const hit = containsBanned(text);
  if (!hit) return;

  const ref = snap!.ref;
  console.warn(`금칙어로 격리: ${ref.path} (${hit})`);
  await db.collection('moderationQueue').add({
    sourcePath: ref.path,
    matchedWord: hit,
    authorId: data.authorId ?? null,
    document: data,
    quarantinedAt: FieldValue.serverTimestamp(),
  });
  await ref.delete();
}

export const moderatePost = onDocumentWritten('posts/{postId}', (event) =>
  moderate(event.data?.after, ['body']));

export const moderateReview = onDocumentWritten('places/{placeId}/reviews/{reviewId}', (event) =>
  moderate(event.data?.after, ['text']));

// ─────────────────────────────────────────────────────────────────────────────
// deleteAccount — 회원탈퇴 (Apple 심사 가이드라인 5.1.1(v))
//
// 계정을 만들게 하는 앱은 앱 안에서 계정 삭제까지 제공해야 한다. 비활성화나 문의 안내로는
// 통과하지 못한다.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Auth 계정은 마지막에 지운다. 중간에 실패해도 사용자가 그대로 남아 다시 부를 수 있다 —
 * 먼저 지우면 남은 데이터를 지울 주체가 사라진다.
 *
 * ponytail: 컬렉션당 한 번씩 읽고 끝이다 — 페이지네이션 없음. 한 사람 몫이라 수천 건이
 * 될 일이 없다. 넘치기 시작하면 쿼리를 커서로 돌린다.
 */
export const deleteAccount = onCall(async (req) => {
  const uid = requireUid(req);

  // 티켓과 갤러리는 짝이다 — 갤러리 문서 id 가 티켓 id 다 (issueTicket 참고).
  const tickets = await db.collection('tickets').where('userId', '==', uid).get();
  const refs = tickets.docs.flatMap((d) => [
    d.ref,
    db.doc(`places/${d.data().placeId}/gallery/${d.id}`),
  ]);

  for (const q of [
    db.collection('posts').where('authorId', '==', uid),
    db.collectionGroup('reviews').where('authorId', '==', uid),
    db.collection('raffleEntries').where('userId', '==', uid),
    db.collection('verificationSessions').where('userId', '==', uid),
  ]) {
    refs.push(...(await q.get()).docs.map((d) => d.ref));
  }

  const writer = db.bulkWriter();
  refs.forEach((ref) => writer.delete(ref));

  // 본인이 넣은 신고는 지우지 않고 신원만 지운다 — 이건 그 사람이 신고당한 기록이 아니라
  // 신고한 기록이라, 지우면 다른 사용자에 대한 모더레이션 근거가 같이 사라진다.
  const ownReports = await db.collection('reports').where('reporterId', '==', uid).get();
  ownReports.docs.forEach((d) => writer.update(d.ref, { reporterId: 'deleted' }));

  // 장소 카운터도 되돌린다. 안 두면 갤러리에 없는 사진 수가 장소 화면에 영원히 남는다.
  const perPlace = new Map<string, number>();
  for (const d of tickets.docs) {
    const placeId = d.data().placeId as string;
    perPlace.set(placeId, (perPlace.get(placeId) ?? 0) + 1);
  }
  for (const [placeId, n] of perPlace) {
    writer.update(db.doc(`places/${placeId}`), {
      ticketCount: FieldValue.increment(-n),
      photoCount: FieldValue.increment(-n),
    });
  }
  await writer.close();

  // 하위 컬렉션(savedPlaces)까지 같이 지운다. 일일 상한 카운터는 users 밖에 있어 따로 지운다.
  await Promise.all([
    db.recursiveDelete(db.doc(`users/${uid}`)),
    db.doc(`rateLimits/${uid}`).delete(),
  ]);

  // 사진 원본. storage.rules 가 tickets/{uid}/ 와 posts/{uid}/ 둘만 허용한다.
  const bucket = getStorage().bucket();
  await Promise.all([
    bucket.deleteFiles({ prefix: `tickets/${uid}/` }),
    bucket.deleteFiles({ prefix: `posts/${uid}/` }),
  ]);

  await getAuth().deleteUser(uid);
  return { deletedDocs: refs.length + 1 };
});

/** Public profile projection; never expose the private users document/email. */
export const getPublicProfile = onCall(async (req) => {
  requireVerifiedUid(req);
  const userId = docId((req.data ?? {}) as Data, 'userId');
  const snap = await db.doc(`users/${userId}`).get();
  if (!snap.exists) throw new HttpsError('not-found', '없는 사용자다');
  const user = snap.data() as Data;
  // 가입 시 users 문서에 profileVisibility 를 쓰지 않는다 — 앱의 읽기 기본값도 'public' 이라
  // 값이 없는 것은 공개로 본다. 없음을 비공개로 치면 모든 신규 사용자의 프로필이 막힌다.
  if (user.profileVisibility === 'private') throw new HttpsError('permission-denied', '비공개 프로필이다');
  return {
    userId,
    nickname: String(user.nickname ?? ''),
    bio: typeof user.bio === 'string' ? user.bio : '',
    avatarUrl: typeof user.avatarUrl === 'string' ? user.avatarUrl : '',
    ticketsIssued: Number(user.ticketsIssued ?? 0),
    placesVisited: Number(user.placesVisited ?? 0),
    tier: String(user.tier ?? 'club10'),
  };
});
