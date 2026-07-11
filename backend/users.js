// ==============================================================================
// 사용자 관리 API 비즈니스 로직
//
//   GET    /users           : 사용자 목록 조회        (admin, Parents)
//   POST   /users           : 사용자 생성              (admin, Parents)
//   DELETE /users           : 사용자 삭제              (admin, Parents)
//   PATCH  /users/group     : 권한(그룹) 변경          (admin 전용)
//   PATCH  /users/status    : 활성/비활성 변경         (admin 전용)
//   POST   /reset-password  : 비밀번호 초기화          (admin 전용)
//
// admin 계정은 scripts/create-admin.sh 로만 생성되고 scripts/delete-user.sh 로만
// 삭제되므로, 이 모듈의 어떤 경로로도 admin 을 생성/변경/삭제할 수 없다.
// ==============================================================================

import { getAuthContext, requireAdmin, requireGroup, ADMIN_GROUP, PARENTS_GROUP } from './auth.js';
import {
  createUser,
  listUsers,
  changeUserGroup,
  setUserStatus,
  resetUserPassword,
  getUserFamilyAndRole,
  deleteUserAccount,
  cleanupFamilyGroupIfNoParents,
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
 * 사용자 목록을 조회한다. (admin, Parents)
 *
 * admin: 기본은 본인 가족 목록이며, family_id=all 로 전체, family_id=<값> 으로
 *        특정 가족을 조회할 수 있다.
 * Parents: 항상 본인이 속한 가족의 사용자 목록만 조회할 수 있다 (쿼리 파라미터 무시).
 */
export async function handleListUsers(event) {
  const auth = getAuthContext(event);
  requireGroup(auth, [ADMIN_GROUP, PARENTS_GROUP]);

  let familyId;
  if (auth.role !== ADMIN_GROUP) {
    familyId = auth.familyId; // 부모는 항상 본인 가족만 조회 가능
  } else {
    const queryFamilyId = event?.queryStringParameters?.family_id;
    if (queryFamilyId === 'all') {
      familyId = null; // 전체 사용자 조회
    } else if (queryFamilyId) {
      familyId = requireFamilyId(queryFamilyId);
    } else {
      // 기본: 관리자 본인 가족 (가족 그룹에 속하지 않은 admin 은 전체 조회)
      familyId = auth.familyId;
    }
  }

  const users = await listUsers(familyId);

  return ok({ users });
}

/**
 * POST /users
 * 신규 사용자(부모/자녀)를 생성한다. (admin, Parents)
 *
 * admin: family_id 를 지정하여 어느 가족에도 사용자를 추가할 수 있다.
 *        (가족 그룹이 미리 존재해야 함 - POST /groups 로 생성)
 * Parents: 본인이 속한 가족에만 사용자를 추가할 수 있다 (family_id 무시).
 *
 * 요청 본문:
 *   - username  : 사용자 이름 (필수, 영문/숫자/._- 3~30자)
 *   - name      : 표시 이름 (필수)
 *   - family_id : 가족 ID (admin 만 사용, Parents 는 본인 가족으로 고정됨)
 *   - group     : 역할 그룹 Parents/Children (필수, admin 은 API 로 부여 불가)
 *
 * 응답에 임시 비밀번호가 포함되며, 사용자는 최초 로그인 시
 * NEW_PASSWORD_REQUIRED Challenge 로 새 비밀번호를 설정해야 한다.
 */
export async function handleCreateUser(event) {
  const auth = getAuthContext(event);
  requireGroup(auth, [ADMIN_GROUP, PARENTS_GROUP]);

  const body = parseJsonBody(event);

  const username = requireUsername(body.username);
  const name = requireString(body.name, 'name', 50);
  const group = requireString(body.group, 'group', 20);

  // 부모는 본인 가족에만 사용자를 추가할 수 있음 (본문의 family_id 는 무시)
  const familyId = auth.role === ADMIN_GROUP ? requireFamilyId(body.family_id) : auth.familyId;

  const result = await createUser({ username, name, familyId, group });

  return created({
    message: '사용자가 생성되었습니다. 임시 비밀번호를 사용자에게 안전하게 전달하세요.',
    username: result.username,
    temporary_password: result.temporaryPassword,
  });
}

/**
 * DELETE /users
 * 사용자를 삭제한다. (admin, Parents)
 *
 * admin: 어느 가족의 사용자든 삭제할 수 있다.
 * Parents: 본인이 속한 가족의 사용자만 삭제할 수 있다 (본인 포함, 자기 자신도 삭제 가능).
 *
 * admin 역할 계정은 이 경로로 삭제할 수 없다 (scripts/delete-user.sh 전용).
 *
 * 가족 그룹에 부모(Parents)가 한 명도 남지 않게 되면, 남은 자녀 계정도 함께
 * 삭제되고 가족 그룹 자체도 삭제된다.
 *
 * 요청 본문:
 *   - username : 삭제할 사용자 이름 (필수)
 */
export async function handleDeleteUser(event) {
  const auth = getAuthContext(event);
  requireGroup(auth, [ADMIN_GROUP, PARENTS_GROUP]);

  const body = parseJsonBody(event);
  const username = requireUsername(body.username);

  const target = await getUserFamilyAndRole(username);

  if (target.role === ADMIN_GROUP) {
    throw new HttpError(400, '관리자 계정은 scripts/delete-user.sh 로만 삭제할 수 있습니다.');
  }

  if (auth.role !== ADMIN_GROUP && target.familyId !== auth.familyId) {
    throw new HttpError(403, '본인 가족 소속 사용자만 삭제할 수 있습니다.');
  }

  await deleteUserAccount(username);

  const cleanup = target.familyId
    ? await cleanupFamilyGroupIfNoParents(target.familyId)
    : { groupDeleted: false, removedChildren: [] };

  return ok({
    message: '사용자가 삭제되었습니다.',
    username,
    family_group_deleted: cleanup.groupDeleted,
    also_removed: cleanup.removedChildren,
  });
}

/**
 * PATCH /users/group
 * 사용자의 역할 그룹을 변경한다. (admin 전용)
 * admin 역할은 API 로 부여/변경할 수 없다 (scripts/create-admin.sh 전용).
 *
 * 요청 본문:
 *   - username : 대상 사용자 이름 (필수)
 *   - group    : 변경할 역할 그룹 Parents/Children (필수)
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
