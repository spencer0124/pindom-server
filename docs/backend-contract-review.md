# Backend Contract 리뷰

> `docs/reference/backend-contract.md` 에 대한 백엔드 쪽 답변. 항목이 정해지는 대로 계속 추가함.

## 목차

- [Q1. 속도 검증 임계값 — 위치 스푸핑 방어](#q1-속도-검증-임계값--위치-스푸핑-방어)

---

# Q1. 속도 검증 임계값 — 위치 스푸핑 방어

## 결론

제안한 속도 검사(150 / 300km/h) 방향은 맞음. 두 가지만 바꾸자.

1. 판정 조건을 **시간이 아니라 거리 기준**으로 — 오탐 막으려던 조건이 그대로 공격 통로가 됨
2. **App Check을 방어 1단으로 추가** — 속도 검사만으로는 가장 흔한 스푸핑을 못 막음. 앱 쪽 작업 필요

---

## 1. 속도 검사 — 조건을 거리 기준으로

### 문제

GPS는 사용자가 가만히 있어도 측정값이 30~50m씩 흔들린다. 짧은 간격의 두 측정값으로 속도를 계산하면 이 흔들림이 시속 100km 이상으로 잡힌다. 정상 사용자가 스푸퍼로 판정돼 티켓을 못 받는다.

이걸 막으려고 "측정 간격이 30초 미만이면 속도 계산을 생략" 하는 규칙을 먼저 검토했는데, 그러면 28초마다 좌표를 옮기는 방식으로 검사를 영구히 회피할 수 있다. 시간 조건 자체가 구멍이다.

### 해결

막아야 할 대상은 "짧은 시간"이 아니라 "작은 거리 흔들림"이었다. 조건을 바꾼다.

> **두 측정값 사이 거리가 200m 미만이면 속도 계산을 생략한다. 200m 이상이면 간격과 무관하게 항상 계산한다.**

- GPS 흔들림은 200m를 넘지 않는다 → 정상 사용자 오탐이 사라진다
- 실제 순간이동은 거리가 크므로 2초 만에 옮겨도 항상 걸린다
- 시간 조건이 없으니 회피 통로도 없다

### 확정값

| 항목 | 값 |
| --- | --- |
| 세션 내 연속 측정 | 200m 이상 이동한 쌍만 계산, **150km/h** 초과 시 거부 |
| 직전 발행 티켓 대비 | **300km/h** 초과 시 거부 (KTX·국내선 커버) |
| 거리 계산 | GPS 오차 반경만큼 차감 후 계산 |

거부는 계약서대로 `verified: false`, `reason: 'implausible_speed'`. throw 아님.

---

## 2. App Check 추가 — 앱 쪽 작업이 필요한 부분

### 왜 속도 검사만으로는 부족한가

Fake GPS 류 앱으로 좌표를 목적지에 고정해두고 가만히 있으면 속도가 0이라 속도 검사에 걸리지 않는다. 반경 검사도 통과한다. **현재 계약서의 검사만으로는 가장 흔한 스푸핑 수법을 못 막는다.**

### 방어 3단 구성

| 단계 | 무엇 | 막는 것 |
| --- | --- | --- |
| 1 | **Firebase App Check** (Play Integrity / App Attest) | 뜯어고친 APK, 에뮬레이터, 루팅·탈옥 기기, 앱 없이 함수 직접 호출 |
| 2 | **OS의 mock location 플래그** | 개발자옵션으로 도는 Fake GPS 앱 (루팅 불필요, 가장 흔함) |
| 3 | **반경 + 속도 검사** (현재 계약서) | 위 둘을 뚫고 들어온 케이스 |

셋이 서로 다른 구멍을 막는다. 1단이 없으면 앱을 고쳐 2·3단을 무력화할 수 있어서 App Check이 사실상 전제 조건이다. Firebase 기능이라 백엔드 쪽은 켜기만 하면 된다.

### 앱 쪽에 필요한 작업

1. `@react-native-firebase/app-check` 설치 및 초기화
2. Firebase 콘솔 등록(Play Integrity / App Attest)은 백엔드에서 처리
3. `verifyLocation` 요청에 `isMock: boolean` 추가
   - Android: `Location.isFromMockProvider()` (API 31+ 는 `isMock`)
   - iOS: 해당 API 없음. `false` 고정으로 보내고 App Check이 커버

### 계약서 변경 요청

```ts
// verifyLocation request
{
  placeId: string;
  lat: number;
  lng: number;
  accuracy: number;
  capturedAt: string;
  sessionId?: string;
  isMock: boolean;      // ← 추가. 기기가 보고한 mock location 여부
}

// reason union
'out_of_radius' | 'implausible_speed' | 'poor_accuracy' | 'mock_location'  // ← 추가
```

`isMock: true` 면 `verified: false` + `reason: 'mock_location'`. 인증 실패 화면에서 어떻게 표시할지는 앱 쪽 판단에 맡긴다.

---

## 3. 한계

100% 차단은 불가능하다. 업계 표준도 완전 차단이 아니라 **뚫는 비용을 보상보다 비싸게 만드는 것**이 목표다. 티켓 보상이 응모권 수준이면 위 3단으로 충분하다고 본다.

---

## 필요한 답변

1. `isMock` 필드와 `'mock_location'` 사유 추가 — 괜찮은지
2. App Check 앱 쪽 연동 — 일정상 언제 가능한지 (백엔드는 Phase 4 함수 배포 때 켜면 됨)
3. 속도 임계값 150 / 300km/h — 이견 있는지
