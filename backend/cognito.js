// ==============================================================================
// Cognito 사용자 관리 모듈
//
// AdminCreateUser / AdminSetUserPassword 등 관리자 API 를 감싸며,
// Cognito 오류를 사용자 친화적인 HttpError 로 변환한다.
// ==============================================================================

import {
  CognitoIdentityProviderClient,
  AdminCreateUserCommand,
  AdminAddUserToGroupCommand,
  AdminRemoveUserFromGroupCommand,
  AdminListGroupsForUserCommand,
  AdminDisableUserCommand,
  AdminEnableUserCommand,
  AdminSetUserPasswordCommand,
  AdminGetUserCommand,
  ListUsersCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { HttpError, generateTempPassword } from './utils.js';
import { ADMIN_GROUP, PARENTS_GROUP, CHILDREN_GROUP } from './auth.js';

// 환경변수에서 User Pool ID 로드 (하드코딩 금지)
const USER_POOL_ID = process.env.USER_POOL_ID;

// 유효한 그룹 목록
export const VALID_GROUPS = Object.freeze([ADMIN_GROUP, PARENTS_GROUP, CHILDREN_GROUP]);

// 클라이언트는 실행 환경 당 1회만 생성하여 재사용
const client = new CognitoIdentityProviderClient({});

/**
 * Cognito 오류를 HttpError 로 변환한다.
 * @param {Error} err Cognito SDK 오류
 * @throws {HttpError}
 */
function translateCognitoError(err) {
  switch (err.name) {
    case 'UsernameExistsException':
      throw new HttpError(409, '이미 존재하는 사용자 이름입니다.');
    case 'UserNotFoundException':
      throw new HttpError(404, '해당 사용자를 찾을 수 없습니다.');
    case 'InvalidParameterException':
      throw new HttpError(400, '요청 파라미터가 올바르지 않습니다.');
    case 'InvalidPasswordException':
      throw new HttpError(400, '비밀번호가 정책을 만족하지 않습니다.');
    case 'LimitExceededException':
    case 'TooManyRequestsException':
      throw new HttpError(429, '요청이 너무 많습니다. 잠시 후 다시 시도하세요.');
    default:
      throw err;
  }
}

/**
 * Cognito 사용자 속성 배열에서 특정 속성 값을 찾는다.
 * @param {Array<{Name: string, Value: string}>} attributes 속성 배열
 * @param {string} name 속성 이름
 * @returns {string|null} 속성 값
 */
function getAttribute(attributes, name) {
  const found = (attributes ?? []).find((attr) => attr.Name === name);
  return found ? found.Value : null;
}

/**
 * 사용자가 속한 그룹 목록을 조회한다. (페이지네이션 처리)
 * @param {string} username 사용자 이름
 * @returns {Promise<string[]>} 그룹 이름 배열
 */
async function listGroupsForUser(username) {
  const groups = [];
  let nextToken;

  do {
    const result = await client.send(
      new AdminListGroupsForUserCommand({
        UserPoolId: USER_POOL_ID,
        Username: username,
        NextToken: nextToken,
      }),
    );

    groups.push(...(result.Groups ?? []).map((group) => group.GroupName));
    nextToken = result.NextToken;
  } while (nextToken);

  return groups;
}

/**
 * 신규 사용자를 생성하고 그룹에 추가한다.
 * 임시 비밀번호가 발급되며, 최초 로그인 시 NEW_PASSWORD_REQUIRED
 * Challenge 가 자동으로 발생한다.
 *
 * @param {object} params
 * @param {string} params.username 사용자 이름
 * @param {string} params.name 표시 이름
 * @param {string} params.familyId 가족 ID
 * @param {string} params.group 소속 그룹 (admin/Parents/Children)
 * @returns {Promise<{username: string, temporaryPassword: string}>}
 */
export async function createUser({ username, name, familyId, group }) {
  if (!VALID_GROUPS.includes(group)) {
    throw new HttpError(400, `group 값은 ${VALID_GROUPS.join(', ')} 중 하나여야 합니다.`);
  }

  const temporaryPassword = generateTempPassword();

  try {
    // 1. 사용자 생성 (이메일/SMS 발송 억제 - 비용 0원 유지)
    await client.send(
      new AdminCreateUserCommand({
        UserPoolId: USER_POOL_ID,
        Username: username,
        TemporaryPassword: temporaryPassword,
        MessageAction: 'SUPPRESS',
        UserAttributes: [
          { Name: 'name', Value: name },
          { Name: 'custom:family_id', Value: familyId },
        ],
      }),
    );

    // 2. 그룹 추가
    await client.send(
      new AdminAddUserToGroupCommand({
        UserPoolId: USER_POOL_ID,
        Username: username,
        GroupName: group,
      }),
    );
  } catch (err) {
    translateCognitoError(err);
  }

  // 임시 비밀번호는 이 응답에서만 확인 가능 (저장하지 않음)
  return { username, temporaryPassword };
}

/**
 * 사용자 목록을 조회한다. (페이지네이션 처리)
 * Cognito ListUsers 필터는 커스텀 속성을 지원하지 않으므로,
 * familyId 필터링은 조회 후 Lambda 에서 수행한다.
 *
 * @param {string|null} familyId 특정 가족만 조회할 경우 가족 ID (null 이면 전체)
 * @returns {Promise<Array<object>>} 사용자 목록
 */
export async function listUsers(familyId) {
  const rawUsers = [];
  let paginationToken;

  try {
    do {
      const result = await client.send(
        new ListUsersCommand({
          UserPoolId: USER_POOL_ID,
          Limit: 60,
          PaginationToken: paginationToken,
        }),
      );

      rawUsers.push(...(result.Users ?? []));
      paginationToken = result.PaginationToken;
    } while (paginationToken);
  } catch (err) {
    translateCognitoError(err);
  }

  // familyId 가 지정되면 해당 가족 사용자만 필터링
  const filtered = familyId
    ? rawUsers.filter((user) => getAttribute(user.Attributes, 'custom:family_id') === familyId)
    : rawUsers;

  // 각 사용자의 그룹 정보 병렬 조회 (가족 단위 소규모 풀이므로 부담 없음)
  const users = await Promise.all(
    filtered.map(async (user) => {
      const groups = await listGroupsForUser(user.Username);
      return {
        username: user.Username,
        name: getAttribute(user.Attributes, 'name'),
        family_id: getAttribute(user.Attributes, 'custom:family_id'),
        groups,
        enabled: user.Enabled === true,
        status: user.UserStatus,
        created_at: user.UserCreateDate ? user.UserCreateDate.toISOString() : null,
      };
    }),
  );

  // 사용자 이름 순으로 정렬하여 반환
  users.sort((a, b) => a.username.localeCompare(b.username));
  return users;
}

/**
 * 사용자 존재 여부를 확인한다.
 * @param {string} username 사용자 이름
 * @throws {HttpError} 존재하지 않으면 404
 */
async function ensureUserExists(username) {
  try {
    await client.send(
      new AdminGetUserCommand({
        UserPoolId: USER_POOL_ID,
        Username: username,
      }),
    );
  } catch (err) {
    translateCognitoError(err);
  }
}

/**
 * 사용자의 권한 그룹을 변경한다.
 * 기존 그룹을 모두 제거하고 새 그룹 하나만 부여한다.
 *
 * @param {string} username 대상 사용자 이름
 * @param {string} newGroup 변경할 그룹 (admin/Parents/Children)
 * @returns {Promise<{username: string, group: string}>}
 */
export async function changeUserGroup(username, newGroup) {
  if (!VALID_GROUPS.includes(newGroup)) {
    throw new HttpError(400, `group 값은 ${VALID_GROUPS.join(', ')} 중 하나여야 합니다.`);
  }

  await ensureUserExists(username);

  try {
    const currentGroups = await listGroupsForUser(username);

    // 새 그룹을 제외한 기존 그룹 모두 제거
    for (const group of currentGroups) {
      if (group !== newGroup) {
        await client.send(
          new AdminRemoveUserFromGroupCommand({
            UserPoolId: USER_POOL_ID,
            Username: username,
            GroupName: group,
          }),
        );
      }
    }

    // 새 그룹에 추가 (이미 속해 있어도 오류 없이 무시됨)
    if (!currentGroups.includes(newGroup)) {
      await client.send(
        new AdminAddUserToGroupCommand({
          UserPoolId: USER_POOL_ID,
          Username: username,
          GroupName: newGroup,
        }),
      );
    }
  } catch (err) {
    translateCognitoError(err);
  }

  return { username, group: newGroup };
}

/**
 * 사용자를 활성화 또는 비활성화한다.
 * @param {string} username 대상 사용자 이름
 * @param {boolean} enabled true=활성화, false=비활성화
 * @returns {Promise<{username: string, enabled: boolean}>}
 */
export async function setUserStatus(username, enabled) {
  await ensureUserExists(username);

  try {
    if (enabled) {
      await client.send(
        new AdminEnableUserCommand({
          UserPoolId: USER_POOL_ID,
          Username: username,
        }),
      );
    } else {
      await client.send(
        new AdminDisableUserCommand({
          UserPoolId: USER_POOL_ID,
          Username: username,
        }),
      );
    }
  } catch (err) {
    translateCognitoError(err);
  }

  return { username, enabled };
}

/**
 * 사용자의 비밀번호를 초기화한다.
 * 새 임시 비밀번호를 발급하며(Permanent=false), 사용자는 다음 로그인 시
 * NEW_PASSWORD_REQUIRED Challenge 로 새 비밀번호를 설정해야 한다.
 *
 * @param {string} username 대상 사용자 이름
 * @returns {Promise<{username: string, temporaryPassword: string}>}
 */
export async function resetUserPassword(username) {
  await ensureUserExists(username);

  const temporaryPassword = generateTempPassword();

  try {
    await client.send(
      new AdminSetUserPasswordCommand({
        UserPoolId: USER_POOL_ID,
        Username: username,
        Password: temporaryPassword,
        // Permanent=false → FORCE_CHANGE_PASSWORD 상태가 되어
        // 최초 로그인 시 비밀번호 변경이 강제됨
        Permanent: false,
      }),
    );
  } catch (err) {
    translateCognitoError(err);
  }

  return { username, temporaryPassword };
}
