/**
 * admin 커스텀 클레임 부여·회수. saveBoard 는 이 클레임이 있는 계정만 부를 수 있다.
 *
 *   에뮬레이터:  FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099 \
 *                npm --prefix functions run grant-admin -- --email me@example.com
 *   실제 프로젝트: npm --prefix functions run grant-admin -- \
 *                --email me@example.com --project pindom-1234 --yes
 *
 * 클레임은 ID 토큰에 실린다. 이미 로그인해 있던 관리자는 토큰이 갱신될 때까지(최대 1시간,
 * 또는 getIdToken(true)) 예전 클레임을 들고 있다. 관리 도구는 로그인할 때마다 강제 갱신한다.
 */

import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';

const args = process.argv.slice(2);
const valueOf = (flag) => {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
};

const email = valueOf('--email');
const projectId = valueOf('--project') ?? process.env.GCLOUD_PROJECT ?? 'pindom-seed-local';
const revoke = args.includes('--revoke');
const onEmulator = Boolean(process.env.FIREBASE_AUTH_EMULATOR_HOST);

if (!email) {
  console.error('--email 이 필요하다.');
  process.exit(1);
}

// 실제 프로젝트의 권한을 바꾸는 동작이다. 시드와 같은 문턱을 둔다.
if (!onEmulator && !args.includes('--yes')) {
  console.error(`실제 프로젝트(${projectId})의 권한을 바꿉니다. 확인했으면 --yes 를 붙이세요.`);
  process.exit(1);
}

initializeApp({ projectId });

const user = await getAuth().getUserByEmail(email);
// 기존 클레임을 지우지 않는다. setCustomUserClaims 는 통째로 덮어쓴다.
const claims = { ...(user.customClaims ?? {}) };
if (revoke) delete claims.admin;
else claims.admin = true;

await getAuth().setCustomUserClaims(user.uid, claims);
console.log(`${email} (${user.uid}) — admin ${revoke ? '회수' : '부여'} 완료`);
console.log('해당 계정은 다시 로그인해야 새 클레임이 반영된다.');
