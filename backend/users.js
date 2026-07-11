// ==============================================================================
// 사용자 관리 API 비즈니스 로직 (모두 admin 전용)
//
//   GET   /users           : 사용자 목록 조회
//   POST  /users           : 사용자 생성
//   PATCH /users/group     : 권한(그룹) 변경
//   PATCH /users/status    : 활성/비활성 변경
//   POST  /reset-password  : 비밀번호 초기화
// ==============================================================================

import { getAuthContext, requireAdmin } from './auth.js';
import {
  createUser,
  listUsers,
  changeUserGroup,
  setUserStatus,
  resetUserPassword,
} from './cognito.js';
import { ok, created } from './response.js';
import {
  HttpError,
  parseJsonBody,
  requireString,
  requireUsername,
  requireFamilyId,
} from './utils.js';

/**
 * GET /users
 * 사용자 목록을 조회한다. (admin 전용)
 * 기본은 관리자 본인 가족의 사용자 목록이며,
 * 쿼리 파라미터 family_id=all 로 전체 조회, family_id=<값> 으로 특정 가족 조회 가능.
 */
export async function handleListUsers(event) {
  const auth = getAuthContext(event);
  requireAdmin(auth);

  const queryFamilyId = event?.queryStringParameters?.family_id;

  let familyId;
  if (queryFamilyId === 'all') {
    familyId = null; // 전체 사용자 조회
  } else if (queryFamilyId) {
    familyId = requireFamilyId(queryFamilyId);
  } else {
    familyId = auth.familyId; // 기본: 관리자 본인 가족
  }

  const users = await listUsers(familyId);

  return ok({ users });
}

/**
 * POST /users
 * 신규 사용자를 생성한다. (admin 전용)
 *
 * 요청 본문:
 *   - username  : 사용자 이름 (필수, 영문/숫자/._- 3~30자)
 *   - name      : 표시 이름 (필수)
 *   - family_id : 가족 ID (필수)
 *   - group     : 그룹 admin/Parents/Children (필수)
 *
 * 응답에 임시 비밀번호가 포함되며, 사용자는 최초 로그인 시
 * NEW_PASSWORD_REQUIRED Challenge 로 새 비밀번호를 설정해야 한다.
 */
export async function handleCreateUser(event) {
  const auth = getAuthContext(event);
  requireAdmin(auth);

  const body = parseJsonBody(event);

  const username = requireUsername(body.username);
  const name = requireString(body.name, 'name', 50);
  const familyId = requireFamilyId(body.family_id);
  const group = requireString(body.group, 'group', 20);

  const result = await createUser({ username, name, familyId, group });

  return created({
    message: '사용자가 생성되었습니다. 임시 비밀번호를 사용자에게 안전하게 전달하세요.',
    username: result.username,
    temporary_password: result.temporaryPassword,
  });
}

/**
 * PATCH /users/group
 * 사용자의 권한 그룹을 변경한다. (admin 전용)
 *
 * 요청 본문:
 *   - username : 대상 사용자 이름 (필수)
 *   - group    : 변경할 그룹 admin/Parents/Children (필수)
 */
export async function handleChangeGroup(event) {
  const auth = getAuthContext(event);
  requireAdmin(auth);

  const body = parseJsonBody(event);

  const username = requireUsername(body.username);
  const group = requireString(body.group, 'group', 20);

  // 자기 자신의 권한 변경은 차단 (admin 권한 상실로 인한 잠금 방지)
  if (username === auth.username) {
    throw new HttpError(400, '자기 자신의 권한은 변경할 수 없습니다.');
  }

  const result = await changeUserGroup(username, group);

  return ok({
    message: '사용자 권한이 변경되었습니다.',
    username: result.username,
    group: result.group,
  });
}

/**
 * PATCH /users/status
 * 사용자를 활성화/비활성화한다. (admin 전용)
 *
 * 요청 본문:
 *   - username : 대상 사용자 이름 (필수)
 *   - enabled  : true=활성화, false=비활성화 (필수, boolean)
 */
export async function handleChangeStatus(event) {
  const auth = getAuthContext(event);
  requireAdmin(auth);

  const body = parseJsonBody(event);

  const username = requireUsername(body.username);

  if (typeof body.enabled !== 'boolean') {
    throw new HttpError(400, 'enabled 값은 true 또는 false 여야 합니다.');
  }

  // 자기 자신의 비활성화는 차단 (관리자 잠금 방지)
  if (username === auth.username && body.enabled === false) {
    throw new HttpError(400, '자기 자신을 비활성화할 수 없습니다.');
  }

  const result = await setUserStatus(username, body.enabled);

  return ok({
    message: result.enabled ? '사용자가 활성화되었습니다.' : '사용자가 비활성화되었습니다.',
    username: result.username,
    enabled: result.enabled,
  });
}

/**
 * POST /reset-password
 * 사용자의 비밀번호를 초기화한다. (admin 전용)
 *
 * 요청 본문:
 *   - username : 대상 사용자 이름 (필수)
 *
 * 응답에 새 임시 비밀번호가 포함되며, 사용자는 다음 로그인 시
 * NEW_PASSWORD_REQUIRED Challenge 로 새 비밀번호를 설정해야 한다.
 */
export async function handleResetPassword(event) {
  const auth = getAuthContext(event);
  requireAdmin(auth);

  const body = parseJsonBody(event);

  const username = requireUsername(body.username);

  const result = await resetUserPassword(username);

  return ok({
    message: '비밀번호가 초기화되었습니다. 임시 비밀번호를 사용자에게 안전하게 전달하세요.',
    username: result.username,
    temporary_password: result.temporaryPassword,
  });
}
