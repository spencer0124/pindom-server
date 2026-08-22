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
