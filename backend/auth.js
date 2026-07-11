// ==============================================================================
// 인증/인가 모듈
//
// API Gateway 의 Cognito JWT Authorizer 가 1차 토큰 검증을 수행하고,
// 이 모듈은 검증된 JWT Claims 에서 사용자 컨텍스트(family_id, 그룹)를
// 추출하여 Lambda 내부에서 2차 권한 검사를 수행한다.
//
// 가족 범위(family_id)는 커스텀 속성이 아니라 Cognito 그룹 멤버십에서 온다.
// 사용자는 다음 그룹에 속해야 한다:
//   1. 역할 그룹 (admin / Parents / Children 중 하나) - 필수
//   2. 가족 그룹 (그룹 이름 = family_id, 동적으로 생성/삭제됨)
//      - Parents/Children 은 필수, admin 은 선택 (가족 없이 전체 관리만 하는 계정 허용)
// ==============================================================================

import { HttpError } from './utils.js';

// 환경변수에서 그룹 이름 로드 (Terraform 과 일치)
export const ADMIN_GROUP = process.env.ADMIN_GROUP;
export const PARENTS_GROUP = process.env.PARENTS_GROUP;
export const CHILDREN_GROUP = process.env.CHILDREN_GROUP;

// 역할 그룹 목록 (가족 그룹과 구분하는 기준)
export const ROLE_GROUPS = Object.freeze([ADMIN_GROUP, PARENTS_GROUP, CHILDREN_GROUP]);

/**
 * HTTP API JWT Authorizer 는 배열 클레임(cognito:groups)을
 * "[admin Parents]" 같은 문자열로 직렬화하여 전달하므로 이를 파싱한다.
 * @param {*} raw claims 의 cognito:groups 원본 값
 * @returns {string[]} 그룹 이름 배열
 */
function parseGroups(raw) {
  if (!raw) {
    return [];
  }

  // 이미 배열인 경우 (REST API 또는 테스트 환경)
  if (Array.isArray(raw)) {
    return raw.map(String);
  }

  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    // "[admin Parents]" → "admin Parents"
    const inner =
      trimmed.startsWith('[') && trimmed.endsWith(']')
        ? trimmed.slice(1, -1)
        : trimmed;

    return inner.split(/[\s,]+/).filter(Boolean);
  }

  return [];
}

/**
 * 그룹 배열을 역할 그룹과 가족 그룹으로 분리한다.
 * @param {string[]} groups 그룹 이름 배열
 * @returns {{roleGroups: string[], familyGroups: string[]}}
 */
function splitGroups(groups) {
  const roleGroups = groups.filter((group) => ROLE_GROUPS.includes(group));
  const familyGroups = groups.filter((group) => !ROLE_GROUPS.includes(group));
  return { roleGroups, familyGroups };
}

/**
 * 요청 이벤트에서 인증 컨텍스트를 추출한다.
 * @param {object} event API Gateway 이벤트 (Payload v2.0)
 * @returns {{username: string, familyId: string|null, role: string, groups: string[]}}
 *          familyId 는 admin 이 가족 그룹에 속하지 않은 경우에만 null 이다.
 * @throws {HttpError} 클레임이 없거나 그룹 구성이 올바르지 않으면 401/403
 */
export function getAuthContext(event) {
  const claims = event?.requestContext?.authorizer?.jwt?.claims;

  if (!claims) {
    // Authorizer 를 통과하지 않은 비정상 요청
    throw new HttpError(401, '인증 정보가 없습니다.');
  }

  const username = claims['cognito:username'];
  const groups = parseGroups(claims['cognito:groups']);

  if (!username) {
    throw new HttpError(401, '토큰에 사용자 정보가 없습니다.');
  }

  const { roleGroups, familyGroups } = splitGroups(groups);

  if (roleGroups.length !== 1) {
    // 역할 그룹(admin/Parents/Children)이 정확히 하나가 아니면 접근 불가
    throw new HttpError(403, '권한 그룹이 올바르게 설정되지 않은 계정입니다. 관리자에게 문의하세요.');
  }

  const role = roleGroups[0];

  if (familyGroups.length > 1) {
    // 어떤 역할이든 가족 그룹이 둘 이상이면 접근 불가
    throw new HttpError(403, '가족 정보(그룹)가 올바르게 설정되지 않은 계정입니다. 관리자에게 문의하세요.');
  }

  if (role !== ADMIN_GROUP && familyGroups.length === 0) {
    // 부모/자녀는 반드시 가족 그룹에 속해야 함 (admin 은 가족 없이도 허용)
    throw new HttpError(403, '가족 정보(그룹)가 설정되지 않은 계정입니다. 관리자에게 문의하세요.');
  }

  return { username, role, familyId: familyGroups[0] ?? null, groups };
}

/**
 * 사용자의 역할이 허용된 역할 중 하나인지 검사한다.
 * @param {{role: string}} authContext getAuthContext 반환값
 * @param {string[]} allowedGroups 허용 역할 그룹 목록
 * @throws {HttpError} 허용되지 않은 역할이면 403
 */
export function requireGroup(authContext, allowedGroups) {
  if (!allowedGroups.includes(authContext.role)) {
    throw new HttpError(403, '이 작업을 수행할 권한이 없습니다.');
  }
}

/**
 * 관리자(admin) 역할인지 검사한다.
 * @param {{role: string}} authContext getAuthContext 반환값
 * @throws {HttpError} admin 이 아니면 403
 */
export function requireAdmin(authContext) {
  requireGroup(authContext, [ADMIN_GROUP]);
}
