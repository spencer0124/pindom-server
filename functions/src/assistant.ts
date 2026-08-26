/**
 * Pindom AI 의 순수 부분. 네트워크도 Firestore 도 건드리지 않아 단위 테스트가 가능하다.
 * 계약서의 Proposal — Pindom AI 절이 원본이다.
 */

import { distanceMeters, type LatLng } from './logic';

/** 사용자당 하루 호출 상한. 이 함수는 호출 한 번이 OpenAI 청구서 한 줄이다. */
export const DAILY_CALL_LIMIT = 30;

/** 모델에 넘기는 이전 대화 길이. 클라이언트가 보낸 것을 그대로 믿지 않는다. */
export const MAX_HISTORY = 10;
export const MAX_MESSAGE_CHARS = 1_000;

/** 모델이 도구를 부를 수 있는 횟수. 질문 하나가 무한히 불어나는 것을 막는다. */
export const MAX_TOOL_ROUNDS = 3;

export const KAKAO_CATEGORIES = {
  cafe: 'CE7',
  restaurant: 'FD6',
  attraction: 'AT4',
} as const;

export type KakaoCategory = keyof typeof KAKAO_CATEGORIES;

export interface Suggestion {
  name: string;
  category: string;
  address: string;
  lat: number;
  lng: number;
  source: 'kakao';
  sourceId: string;
  distanceMeters?: number;
}

/**
 * 하루 경계는 한국 시간 기준이다. UTC 로 세면 한국 사용자에게는 오전 9시에 상한이 풀린다.
 */
export function dayKeyKst(now: Date): string {
  return new Date(now.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/** 오늘 몇 번째 호출인지. 날짜가 바뀌었으면 1 부터 다시 센다. */
export function nextCallCount(storedDay: unknown, storedCount: unknown, today: string): number {
  if (storedDay !== today) return 1;
  return (typeof storedCount === 'number' ? storedCount : 0) + 1;
}

/**
 * 출발지와 촬영지 사이 직선을 n+1 등분한 중간 지점들. "가면서 들를 만한 곳" 이 여기서 나온다.
 *
 * ponytail: 직선이다. 실제 도로 경로를 쓰려면 카카오모빌리티 키가 하나 더 필요한데,
 * 해안선이나 강을 낀 구간에서만 눈에 띄게 어긋난다. 그때 길찾기로 올린다.
 */
export function waypoints(from: LatLng, to: LatLng, n = 2): LatLng[] {
  const out: LatLng[] = [];
  for (let i = 1; i <= n; i += 1) {
    const t = i / (n + 1);
    out.push({ lat: from.lat + (to.lat - from.lat) * t, lng: from.lng + (to.lng - from.lng) * t });
  }
  return out;
}

/** 카카오 로컬 문서 하나를 계약서의 suggestion 모양으로. 좌표는 문자열로 온다. */
export function toSuggestion(doc: Record<string, unknown>, origin?: LatLng): Suggestion | null {
  const lng = Number(doc.x);
  const lat = Number(doc.y);
  const name = typeof doc.place_name === 'string' ? doc.place_name : '';
  if (!name || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  const category = String(doc.category_group_name ?? doc.category_name ?? '').split('>').pop()?.trim();
  const suggestion: Suggestion = {
    name,
    category: category || '장소',
    address: String(doc.road_address_name || doc.address_name || ''),
    lat,
    lng,
    source: 'kakao',
    sourceId: String(doc.id ?? ''),
  };
  // 카카오의 distance 는 요청 좌표 기준이라, 여러 지점을 훑을 때는 출발지 기준으로 다시 잰다.
  if (origin) suggestion.distanceMeters = Math.round(distanceMeters(origin, { lat, lng }));
  return suggestion;
}

/** 같은 장소가 여러 지점 검색에서 중복으로 잡힌다. sourceId 로 걷어낸다. */
export function dedupe(list: Suggestion[]): Suggestion[] {
  const seen = new Set<string>();
  return list.filter((s) => {
    const key = s.sourceId || `${s.lat},${s.lng}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** 클라이언트가 보낸 이전 대화를 자른다. role 은 두 가지만 통과시킨다. */
export function sanitizeHistory(raw: unknown): Array<{ role: 'user' | 'assistant'; content: string }> {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((m): m is Record<string, unknown> => typeof m === 'object' && m !== null)
    .map((m) => ({
      role: m.role === 'assistant' ? ('assistant' as const) : ('user' as const),
      content: typeof m.content === 'string' ? m.content.slice(0, MAX_MESSAGE_CHARS) : '',
    }))
    .filter((m) => m.content !== '')
    .slice(-MAX_HISTORY);
}

export const SYSTEM_PROMPT = `너는 PINDOM 앱의 도우미다. PINDOM 은 아이돌·드라마 촬영지를 직접 찾아가
GPS 로 인증하면 사진 티켓을 받는 앱이다. 한국어로, 짧고 구체적으로 답한다.

앱의 규칙:
- 촬영지 반경 50m 안에서 인증해야 티켓이 나온다. 기기 위치 정확도가 65m 를 넘으면 인증되지 않는다.
- 같은 장소는 30일이 지나야 다시 인증할 수 있다.
- 티켓을 모으면 응모에 쓸 수 있고, 발행 수에 따라 등급이 오른다 (0–19 club10, 20–29 club20, 30+ clubGo).
- 사진은 인증에 성공한 뒤에만 찍을 수 있고, 공개로 올리면 그 장소의 갤러리에 걸린다.

주변 장소를 물으면 search_nearby 도구를 쓴다. 도구가 준 곳만 말하고 지어내지 않는다.
추천한 곳은 앱이 지도에 핀으로 보여주므로, 답변에서 주소나 좌표를 늘어놓지 말고
왜 갈 만한지만 한 줄씩 붙인다. 도구가 아무것도 주지 않으면 없다고 말한다.`;

export const SEARCH_TOOL = {
  type: 'function' as const,
  function: {
    name: 'search_nearby',
    description: '좌표 주변의 카페·음식점·관광명소를 찾는다. 사용자가 주변 추천을 원할 때만 쓴다.',
    parameters: {
      type: 'object',
      properties: {
        lat: { type: 'number', description: '중심 위도' },
        lng: { type: 'number', description: '중심 경도' },
        radiusMeters: { type: 'number', description: '반경. 최대 20000' },
        category: { type: 'string', enum: Object.keys(KAKAO_CATEGORIES) },
        keyword: { type: 'string', description: '"해장국" 처럼 구체적인 말이 있을 때만' },
      },
      required: ['lat', 'lng', 'category'],
    },
  },
};
