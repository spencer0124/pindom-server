import { setGlobalOptions } from 'firebase-functions';

// 리전은 한 번 정하면 함수를 지우고 다시 배포해야만 바뀐다.
// 앱은 getFunctions(app, 'asia-northeast3') 로 호출한다 —
// 기본값 us-central1 로 호출하면 not-found 가 난다.
setGlobalOptions({ region: 'asia-northeast3' });

// verifyLocation · issueTicket · enterRaffle 은 Phase 4 에서 추가한다.
