// ==============================================================================
// 가족 그룹 관리 API 비즈니스 로직 (모두 admin 전용)
//
//   POST   /groups : 가족 그룹 생성
//   DELETE /groups : 가족 그룹 삭제 (그룹에 사용자가 남아있으면 거부)
//
// 그룹 이름 = 가족 ID. 역할 그룹(admin/Parents/Children) 이름과 충돌할 수 없다.
// ==============================================================================

import { getAuthContext, requireAdmin, ROLE_GROUPS } from './auth.js';
import { createFamilyGroup, deleteFamilyGroup } from './cognito.js';
import { ok, created } from './response.js';
import { HttpError, parseJsonBody, requireFamilyId } from './utils.js';

/**
 * family_id 가 역할 그룹 이름(admin/Parents/Children)과 충돌하지 않는지 검증한다.
 * @param {string} familyId 검증할 가족 ID
 * @throws {HttpError} 역할 그룹 이름과 같으면 400
 */
function requireNonReservedFamilyId(familyId) {
  if (ROLE_GROUPS.includes(familyId)) {
    throw new HttpError(400, `family_id 는 예약된 이름(${ROLE_GROUPS.join(', ')})을 사용할 수 없습니다.`);
  }
  return familyId;
}

/**
 * POST /groups
 * 가족 그룹을 생성한다. (admin 전용)
 *
 * 요청 본문:
 *   - family_id : 생성할 가족 ID (필수)
 */
export async function handleCreateGroup(event) {
  const auth = getAuthContext(event);
  requireAdmin(auth);

  const body = parseJsonBody(event);
  const familyId = requireNonReservedFamilyId(requireFamilyId(body.family_id));

  await createFamilyGroup(familyId);

  return created({
    message: '가족 그룹이 생성되었습니다.',
    family_id: familyId,
  });
}

/**
 * DELETE /groups
 * 가족 그룹을 삭제한다. (admin 전용)
 * 그룹에 사용자가 남아있으면 삭제할 수 없다 (먼저 사용자를 모두 삭제해야 함).
 *
 * 요청 본문:
 *   - family_id : 삭제할 가족 ID (필수)
 */
export async function handleDeleteGroup(event) {
  const auth = getAuthContext(event);
  requireAdmin(auth);

  const body = parseJsonBody(event);
  const familyId = requireFamilyId(body.family_id);

  await deleteFamilyGroup(familyId);

  return ok({
    message: '가족 그룹이 삭제되었습니다.',
    family_id: familyId,
  });
}
