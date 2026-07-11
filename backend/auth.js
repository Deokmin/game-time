// ==============================================================================
// 인증/인가 모듈
//
// API Gateway 의 Cognito JWT Authorizer 가 1차 토큰 검증을 수행하고,
// 이 모듈은 검증된 JWT Claims 에서 사용자 컨텍스트(family_id, 그룹)를
// 추출하여 Lambda 내부에서 2차 권한 검사를 수행한다.
// ==============================================================================

import { HttpError } from './utils.js';

// 환경변수에서 그룹 이름 로드 (Terraform 과 일치)
export const ADMIN_GROUP = process.env.ADMIN_GROUP;
export const PARENTS_GROUP = process.env.PARENTS_GROUP;
export const CHILDREN_GROUP = process.env.CHILDREN_GROUP;

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
 * 요청 이벤트에서 인증 컨텍스트를 추출한다.
 * @param {object} event API Gateway 이벤트 (Payload v2.0)
 * @returns {{username: string, familyId: string, groups: string[]}}
 * @throws {HttpError} 클레임이 없거나 family_id 가 없으면 401/403
 */
export function getAuthContext(event) {
  const claims = event?.requestContext?.authorizer?.jwt?.claims;

  if (!claims) {
    // Authorizer 를 통과하지 않은 비정상 요청
    throw new HttpError(401, '인증 정보가 없습니다.');
  }

  const username = claims['cognito:username'];
  const familyId = claims['custom:family_id'];
  const groups = parseGroups(claims['cognito:groups']);

  if (!username) {
    throw new HttpError(401, '토큰에 사용자 정보가 없습니다.');
  }

  if (!familyId) {
    // family_id 가 없는 사용자는 어떤 데이터에도 접근 불가
    throw new HttpError(403, '가족 정보(family_id)가 설정되지 않은 계정입니다. 관리자에게 문의하세요.');
  }

  if (groups.length === 0) {
    // 그룹이 없는 사용자는 어떤 기능도 사용 불가
    throw new HttpError(403, '권한 그룹이 설정되지 않은 계정입니다. 관리자에게 문의하세요.');
  }

  return { username, familyId, groups };
}

/**
 * 사용자가 허용된 그룹 중 하나에 속하는지 검사한다.
 * @param {{groups: string[]}} authContext getAuthContext 반환값
 * @param {string[]} allowedGroups 허용 그룹 목록
 * @throws {HttpError} 어느 그룹에도 속하지 않으면 403
 */
export function requireGroup(authContext, allowedGroups) {
  const hasPermission = authContext.groups.some((group) => allowedGroups.includes(group));

  if (!hasPermission) {
    throw new HttpError(403, '이 작업을 수행할 권한이 없습니다.');
  }
}

/**
 * 관리자(admin) 그룹인지 검사한다.
 * @param {{groups: string[]}} authContext getAuthContext 반환값
 * @throws {HttpError} admin 이 아니면 403
 */
export function requireAdmin(authContext) {
  requireGroup(authContext, [ADMIN_GROUP]);
}
