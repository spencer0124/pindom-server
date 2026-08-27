/**
 * Firebase 를 모르는 순수 계산. 거리와 속도 판정은 값 하나로 티켓이 나오고 안 나오고가
 * 갈리는 자리라, 에뮬레이터 없이 node --test 로 경계값을 찍을 수 있어야 한다.
 *
 * 임계값은 전부 여기 모아 둔다. GPS 는 기기마다 다르게 흔들려서 실측을 보고 조정하게 된다.
 */

/** 정확도 게이트. 이 값을 넘는 측정은 판정도 하지 않고 세션에도 남기지 않는다. */
export const ACCURACY_GATE_M = 65;

/** 이만큼 떨어진 쌍만 속도를 계산한다. GPS 흔들림은 이 거리를 넘지 않는다. */
export const SPEED_TRIGGER_M = 200;

/** 세션 안의 연속 측정 사이 상한. */
export const SESSION_SPEED_KMH = 150;

/** 직전 발행 티켓 대비 상한. KTX·국내선을 덮는다. */
export const TICKET_SPEED_KMH = 300;

/** 인증 통과 후 카메라를 열어둘 시간. 앱 목 구현이 쓰는 값과 맞췄다. */
export const GRANT_TTL_MIN = 10;

/**
 * capturedAt 이 서버 시각에서 이만큼 이상 벌어지면 받지 않는다. 시각은 속도 계산의 분모라
 * 과거 값을 넣으면 어떤 이동도 느려 보인다. 기기 시계가 몇 분 틀어지는 것은 흔하다.
 */
export const CLOCK_SKEW_MIN = 5;

/** 같은 사용자·같은 장소 재발행 간격. */
export const COOLDOWN_DAYS = 30;

/** 세션 문서가 무한히 커지지 않도록 유지하는 측정 개수. */
export const MAX_READINGS = 5;

/** 장소에 radiusMeters 가 없을 때의 기본 반경. */
export const DEFAULT_RADIUS_M = 50;

/**
 * 사용자당 하루 verifyLocation 호출 상한. 세션마다 문서가 하나 생기고 성공하면
 * verifyCount 도 늘어서, 상한 없이 두면 반복 호출만으로 둘 다 무한히 부풀릴 수 있다.
 * GPS 가 여러 번 튀는 실사용을 덮으면서도 스크립트 반복 호출은 막을 만큼 넉넉하게 잡는다.
 */
export const VERIFY_DAILY_LIMIT = 200;

export type Tier = 'club10' | 'club20' | 'clubGo';

export interface LatLng {
  lat: number;
  lng: number;
}

const EARTH_RADIUS_M = 6_371_000;

const toRad = (deg: number) => (deg * Math.PI) / 180;

/** 하버사인. 규칙에는 sqrt 도 삼각함수도 없어서 이 판정이 함수에 있다. */
export function distanceMeters(a: LatLng, b: LatLng): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * 오차 반경을 빼고 남는 거리. 기기가 "반경 15m 안 어딘가" 라고 말하면 사용자에게 유리한
 * 쪽으로 읽는다 — 60m 지점의 15m 오차는 45m 로 친다.
 */
export function effectiveDistance(meters: number, accuracy: number): number {
  return Math.max(0, meters - Math.max(0, accuracy));
}

/** 초가 0 이하이면 판정할 수 없으므로 0 을 돌려 통과시킨다. 시각은 클라이언트가 보낸 값이다. */
export function impliedSpeedKmh(meters: number, seconds: number): number {
  if (seconds <= 0) return 0;
  return (meters / seconds) * 3.6;
}

/**
 * 두 지점이 스푸핑으로 보이는가. 조건이 시간이 아니라 거리인 이유는, "30초 미만이면 생략"
 * 같은 규칙이 28초마다 좌표를 옮기는 방식으로 영구히 회피되기 때문이다.
 */
export function isImplausibleJump(
  meters: number,
  seconds: number,
  limitKmh: number,
): boolean {
  if (meters < SPEED_TRIGGER_M) return false;
  return impliedSpeedKmh(meters, seconds) > limitKmh;
}

/**
 * 등급은 발행 수에서 나온다. 잔액으로 계산하면 응모할 때마다 등급이 내려간다.
 * 구간 폭 10 은 프로토타입의 `TICKETS OWNED 12 / TIER 10—19` 에서 왔다.
 */
export function tierFor(ticketsIssued: number): Tier {
  if (ticketsIssued >= 30) return 'clubGo';
  if (ticketsIssued >= 20) return 'club20';
  return 'club10';
}

/** Crockford Base32 — 대문자와 숫자에서 I·L·O·U 를 뺐다. 1/I, 0/O 를 눈으로 구분하려고. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * PD-XXXX-XXXX-XXXX. 랜덤 8바이트(64비트)에서 12글자를 뽑고 중복 검사는 하지 않는다 —
 * 1억 장을 발행해도 충돌 확률이 무시할 수준이라 발행마다 조회를 한 번 더 할 값어치가 없다.
 */
export function mintSerial(bytes: Uint8Array): string {
  if (bytes.length < 8) throw new Error('mintSerial: 8바이트 이상이 필요하다');
  let bits = 0n;
  for (let i = 0; i < 8; i += 1) bits = (bits << 8n) | BigInt(bytes[i] ?? 0);

  const chars: string[] = [];
  for (let i = 0; i < 12; i += 1) {
    chars.unshift(ALPHABET[Number(bits & 31n)] as string);
    bits >>= 5n;
  }
  const s = chars.join('');
  return `PD-${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}`;
}

/** 문서 id 로 쓰이므로 `/` 가 들어가면 안 된다. */
export const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** 쿨다운이 끝나는 시각. 장소/상세가 날짜로 렌더링한다. */
export function cooldownEndsAt(lastIssuedAt: Date): Date {
  return new Date(lastIssuedAt.getTime() + COOLDOWN_DAYS * 24 * 60 * 60 * 1000);
}

// ─────────────────────────────────────────────────────────────────────────────
// 게시판
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 자유게시판의 문서 id. 아이돌 게시판은 id 가 artistId 라 (계약서의
 * `posts.boardId` = `artists/{artistId}` 를 그대로 유지한다) 아티스트가 아닌 게시판은
 * 이 하나뿐이고, 없어지면 앱의 기본 탭이 사라진다 — 고정 id 로 박고 삭제·보관을 막는다.
 */
export const FREE_BOARD_ID = 'free';

export type BoardKind = 'free' | 'artist';

export interface BoardInput {
  boardId?: unknown;
  kind?: unknown;
  name?: unknown;
  description?: unknown;
  accentColor?: unknown;
  order?: unknown;
  archived?: unknown;
}

export interface BoardDoc {
  kind: BoardKind;
  name: { ko: string; en: string };
  order: number;
  archived: boolean;
  artistId?: string;
  description?: { ko: string; en: string };
  accentColor?: string;
}

const BOARD_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const HEX_COLOR_RE = /^#[0-9A-Fa-f]{6}$/;

function localized(value: unknown, field: string, required: boolean) {
  if (value === undefined) {
    if (required) throw new Error(`${field} 가 없다`);
    return undefined;
  }
  const v = value as Record<string, unknown>;
  if (typeof v !== 'object' || v === null) throw new Error(`${field} 는 {ko, en} 맵이다`);
  const ko = v.ko;
  const en = v.en;
  if (typeof ko !== 'string' || ko.trim() === '') throw new Error(`${field}.ko 가 비었다`);
  if (typeof en !== 'string' || en.trim() === '') throw new Error(`${field}.en 이 비었다`);
  return { ko: ko.trim(), en: en.trim() };
}

/**
 * 관리 도구가 보낸 게시판 입력을 저장할 문서로 정규화한다. Firebase 를 모르는 순수 함수라
 * 경계값을 에뮬레이터 없이 찍을 수 있다. 아티스트 존재 확인만 호출부가 한다 — 읽기가 필요해서다.
 */
export function normalizeBoard(input: BoardInput): { boardId: string; doc: BoardDoc } {
  const boardId = input.boardId;
  if (typeof boardId !== 'string' || !BOARD_ID_RE.test(boardId)) {
    throw new Error('boardId 는 [A-Za-z0-9_-] 1~64자다');
  }

  const kind = input.kind;
  if (kind !== 'free' && kind !== 'artist') throw new Error('kind 는 free 또는 artist 다');

  // 두 방향 다 막는다. free 를 다른 id 로 만들면 기본 탭이 둘이 되고, free 문서를
  // artist 로 바꾸면 존재하지 않는 아티스트를 가리키는 아이돌 게시판이 된다.
  if ((kind === 'free') !== (boardId === FREE_BOARD_ID)) {
    throw new Error(`자유게시판은 id 가 ${FREE_BOARD_ID} 여야 하고, 그 id 는 자유게시판 전용이다`);
  }

  const archived = input.archived === undefined ? false : input.archived;
  if (typeof archived !== 'boolean') throw new Error('archived 는 불리언이다');
  if (archived && kind === 'free') throw new Error('자유게시판은 보관할 수 없다');

  const order = input.order === undefined ? 0 : input.order;
  if (typeof order !== 'number' || !Number.isFinite(order)) throw new Error('order 는 숫자다');

  const accentColor = input.accentColor;
  if (accentColor !== undefined && (typeof accentColor !== 'string' || !HEX_COLOR_RE.test(accentColor))) {
    throw new Error('accentColor 는 #RRGGBB 다');
  }

  const description = localized(input.description, 'description', false);
  const doc: BoardDoc = {
    kind,
    name: localized(input.name, 'name', true) as { ko: string; en: string },
    order,
    archived,
    // 아이돌 게시판은 id 가 곧 artistId 다. 필드로도 두는 이유는 앱이 kind 로 갈래를
    // 나누지 않고 artistId 유무만 보고 아티스트를 붙일 수 있게 하기 위해서다.
    ...(kind === 'artist' && { artistId: boardId }),
    ...(description && { description }),
    ...(accentColor !== undefined && { accentColor }),
  };
  return { boardId, doc };
}

// ─────────────────────────────────────────────────────────────────────────────
// 아티스트
// ─────────────────────────────────────────────────────────────────────────────

export interface ArtistInput {
  artistId?: unknown;
  name?: unknown;
  initial?: unknown;
  imageUrl?: unknown;
  accentColor?: unknown;
}

export interface ArtistDoc {
  name: { ko: string; en: string };
  initial?: string;
  imageUrl?: string;
  accentColor?: string;
}

/**
 * 아이돌 게시판은 존재하는 artistId 를 요구한다 (normalizeBoard). 그 존재를 만드는 게
 * 이 함수다 — 없으면 관리 도구에서 이름도 못 적고 아이돌 게시판을 만들 수 없었다.
 */
export function normalizeArtist(input: ArtistInput): { artistId: string; doc: ArtistDoc } {
  const artistId = input.artistId;
  if (typeof artistId !== 'string' || !BOARD_ID_RE.test(artistId)) {
    throw new Error('artistId 는 [A-Za-z0-9_-] 1~64자다');
  }

  const initial = input.initial;
  if (initial !== undefined && (typeof initial !== 'string' || initial.trim() === '')) {
    throw new Error('initial 은 빈 문자열일 수 없다');
  }
  const imageUrl = input.imageUrl;
  if (imageUrl !== undefined && typeof imageUrl !== 'string') throw new Error('imageUrl 은 문자열이다');
  const accentColor = input.accentColor;
  if (accentColor !== undefined && (typeof accentColor !== 'string' || !HEX_COLOR_RE.test(accentColor))) {
    throw new Error('accentColor 는 #RRGGBB 다');
  }

  const doc: ArtistDoc = {
    name: localized(input.name, 'name', true) as { ko: string; en: string },
    ...(initial !== undefined && { initial: initial.trim() }),
    ...(imageUrl !== undefined && { imageUrl }),
    ...(accentColor !== undefined && { accentColor }),
  };
  return { artistId, doc };
}

// ─────────────────────────────────────────────────────────────────────────────
// 촬영지 (ticket location)
// ─────────────────────────────────────────────────────────────────────────────

export interface PlaceInput {
  placeId?: unknown;
  name?: unknown;
  address?: unknown;
  lat?: unknown;
  lng?: unknown;
  radiusMeters?: unknown;
  coverImageUrl?: unknown;
  artistIds?: unknown;
  description?: unknown;
}

export interface PlaceDoc {
  name: { ko: string; en: string };
  lat: number;
  lng: number;
  radiusMeters: number;
  artistIds: string[];
  address?: string;
  coverImageUrl?: string;
  description?: { ko: string; en: string };
}

/**
 * 관리 도구가 보낸 촬영지 입력을 정규화한다. artistIds 존재 확인은 호출부가 한다 — 읽기가
 * 필요해서다. placeId 가 없으면 새 문서다 — TourAPI 적재본과 달리 사람이 붙인 slug 를
 * 의미로 쓰는 곳이 없어 auto id 로 충분하다.
 */
export function normalizePlace(input: PlaceInput): { placeId: string | undefined; doc: PlaceDoc } {
  const placeId = input.placeId;
  if (placeId !== undefined && (typeof placeId !== 'string' || !BOARD_ID_RE.test(placeId))) {
    throw new Error('placeId 는 [A-Za-z0-9_-] 1~64자다');
  }

  const lat = input.lat;
  if (typeof lat !== 'number' || !Number.isFinite(lat) || lat < -90 || lat > 90) {
    throw new Error('lat 은 -90~90 숫자다');
  }
  const lng = input.lng;
  if (typeof lng !== 'number' || !Number.isFinite(lng) || lng < -180 || lng > 180) {
    throw new Error('lng 는 -180~180 숫자다');
  }

  const radiusMeters = input.radiusMeters === undefined ? DEFAULT_RADIUS_M : input.radiusMeters;
  if (typeof radiusMeters !== 'number' || !Number.isFinite(radiusMeters) || radiusMeters <= 0) {
    throw new Error('radiusMeters 는 양수다');
  }

  const artistIds = input.artistIds === undefined ? [] : input.artistIds;
  if (!Array.isArray(artistIds) || artistIds.some((id) => typeof id !== 'string' || !BOARD_ID_RE.test(id))) {
    throw new Error('artistIds 는 문자열 배열이다');
  }

  const address = input.address;
  if (address !== undefined && (typeof address !== 'string' || address.trim() === '')) {
    throw new Error('address 는 빈 문자열일 수 없다');
  }
  const coverImageUrl = input.coverImageUrl;
  if (coverImageUrl !== undefined && typeof coverImageUrl !== 'string') {
    throw new Error('coverImageUrl 은 문자열이다');
  }

  const description = localized(input.description, 'description', false);
  const doc: PlaceDoc = {
    name: localized(input.name, 'name', true) as { ko: string; en: string },
    lat,
    lng,
    radiusMeters,
    artistIds: artistIds as string[],
    ...(address !== undefined && { address: address.trim() }),
    ...(coverImageUrl !== undefined && { coverImageUrl }),
    ...(description && { description }),
  };
  return { placeId, doc };
}

// ─────────────────────────────────────────────────────────────────────────────
// 금칙어 — Apple 심사 가이드라인 1.2 가 요구하는 서버 측 콘텐츠 필터
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 목록은 일부러 짧다. 길어질수록 오검출이 늘고, 오검출은 멀쩡한 글이 소리 없이 사라지는
 * 일이라 미검출보다 나쁘다. "보지" · "씹" 처럼 평범한 용언에 그대로 들어 있는 낱말은
 * 넣지 않는다 — 공백을 지우고 보기 때문에 "보지 못했다" 가 걸린다.
 */
export const BANNED_WORDS = [
  '시발', '씨발', '시팔', '씨팔', 'ㅅㅂ', 'ㅄ', 'ㅂㅅ',
  '병신', '븅신', '좆', '존나', '지랄', '개새끼', '개새기',
  '미친놈', '미친년', '썅', '엠창', '느금마',
  'fuck', 'shit', 'bitch', 'asshole',
];

/**
 * 걸린 낱말을 돌려준다. 없으면 undefined.
 *
 * 공백·구두점을 지우고 소문자로 맞춘 뒤 본다 — "시 발", "s.h.i.t" 같은 회피를 막는다.
 *
 * ponytail: 단순 부분 문자열 검사다. 공백을 지우는 탓에 낱말 경계를 넘어 붙는 오검출이
 * 남는다. 실제로 문제가 되면 그때 형태소 분석이나 외부 모더레이션 API 로 올린다.
 */
export function containsBanned(text: string): string | undefined {
  const flat = text.toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
  return BANNED_WORDS.find((w) => flat.includes(w));
}
