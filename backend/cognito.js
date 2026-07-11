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
  AdminDeleteUserCommand,
  ListUsersCommand,
  ListUsersInGroupCommand,
  CreateGroupCommand,
  DeleteGroupCommand,
  GetGroupCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { HttpError, generateTempPassword } from './utils.js';
import { ADMIN_GROUP, PARENTS_GROUP, CHILDREN_GROUP, ROLE_GROUPS } from './auth.js';

// 환경변수에서 User Pool ID 로드 (하드코딩 금지)
const USER_POOL_ID = process.env.USER_POOL_ID;

// API 로 신규 사용자를 생성할 때 부여 가능한 역할 (admin 은 scripts/create-admin.sh 로만 부여)
export const VALID_GROUPS = Object.freeze([PARENTS_GROUP, CHILDREN_GROUP]);

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
 * 가족 그룹(Cognito Group, 이름 = family_id)이 존재하는지 확인한다.
 * @param {string} familyId 가족 ID
 * @throws {HttpError} 존재하지 않으면 404
 */
async function ensureFamilyGroupExists(familyId) {
  try {
    await client.send(new GetGroupCommand({ UserPoolId: USER_POOL_ID, GroupName: familyId }));
  } catch (err) {
    if (err.name === 'ResourceNotFoundException') {
      throw new HttpError(404, '존재하지 않는 가족 그룹입니다. 먼저 그룹을 생성하세요.');
    }
    translateCognitoError(err);
  }
}

/**
 * 신규 사용자(부모/자녀)를 생성하고 역할 그룹과 가족 그룹에 추가한다.
 * 임시 비밀번호가 발급되며, 최초 로그인 시 NEW_PASSWORD_REQUIRED
 * Challenge 가 자동으로 발생한다.
 *
 * 관리자(admin) 계정은 이 함수로 생성할 수 없다 (scripts/create-admin.sh 전용).
 *
 * @param {object} params
 * @param {string} params.username 사용자 이름
 * @param {string} params.name 표시 이름
 * @param {string} params.familyId 가족 ID (이미 존재하는 가족 그룹이어야 함)
 * @param {string} params.group 소속 역할 그룹 (Parents/Children)
 * @returns {Promise<{username: string, temporaryPassword: string}>}
 */
export async function createUser({ username, name, familyId, group }) {
  if (!VALID_GROUPS.includes(group)) {
    throw new HttpError(
      400,
      `group 값은 ${VALID_GROUPS.join(', ')} 중 하나여야 합니다. admin 계정은 scripts/create-admin.sh 로만 생성할 수 있습니다.`,
    );
  }

  await ensureFamilyGroupExists(familyId);

  const temporaryPassword = generateTempPassword();

  try {
    // 1. 사용자 생성 (이메일/SMS 발송 억제 - 비용 0원 유지)
    await client.send(
      new AdminCreateUserCommand({
        UserPoolId: USER_POOL_ID,
        Username: username,
        TemporaryPassword: temporaryPassword,
        MessageAction: 'SUPPRESS',
        UserAttributes: [{ Name: 'name', Value: name }],
      }),
    );

    // 2. 역할 그룹 + 가족 그룹 추가 (사용자는 반드시 두 그룹 모두에 소속되어야 함)
    await client.send(
      new AdminAddUserToGroupCommand({
        UserPoolId: USER_POOL_ID,
        Username: username,
        GroupName: group,
      }),
    );
    await client.send(
      new AdminAddUserToGroupCommand({
        UserPoolId: USER_POOL_ID,
        Username: username,
        GroupName: familyId,
      }),
    );
  } catch (err) {
    translateCognitoError(err);
  }

  // 임시 비밀번호는 이 응답에서만 확인 가능 (저장하지 않음)
  return { username, temporaryPassword };
}

/**
 * 특정 그룹(역할 그룹 또는 가족 그룹)에 속한 사용자 목록을 조회한다. (페이지네이션 처리)
 * @param {string} groupName 그룹 이름
 * @returns {Promise<Array<object>>} Cognito 사용자 원본 목록 (Attributes 포함)
 */
async function listUsersInGroup(groupName) {
  const users = [];
  let nextToken;

  do {
    const result = await client.send(
      new ListUsersInGroupCommand({
        UserPoolId: USER_POOL_ID,
        GroupName: groupName,
        NextToken: nextToken,
      }),
    );

    users.push(...(result.Users ?? []));
    nextToken = result.NextToken;
  } while (nextToken);

  return users;
}

/**
 * 그룹 이름 배열에서 가족 그룹(역할 그룹이 아닌 것) 이름을 찾는다.
 * @param {string[]} groups 그룹 이름 배열
 * @returns {string|null} 가족 그룹 이름
 */
function findFamilyGroup(groups) {
  return groups.find((group) => !ROLE_GROUPS.includes(group)) ?? null;
}

/**
 * 사용자 목록을 조회한다.
 *
 * familyId 가 지정되면 해당 가족 그룹 멤버만 조회한다 (효율적).
 * familyId 가 null 이면 User Pool 전체 사용자를 조회한다 (관리자 전용 "전체 보기").
 *
 * @param {string|null} familyId 특정 가족만 조회할 경우 가족 ID (null 이면 전체)
 * @returns {Promise<Array<object>>} 사용자 목록
 */
export async function listUsers(familyId) {
  let rawUsers;

  try {
    if (familyId) {
      rawUsers = await listUsersInGroup(familyId);
    } else {
      rawUsers = [];
      let paginationToken;
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
    }
  } catch (err) {
    if (err.name === 'ResourceNotFoundException') {
      return []; // 존재하지 않는 가족 그룹 조회 시 빈 목록
    }
    translateCognitoError(err);
  }

  // 각 사용자의 그룹 정보 병렬 조회 (가족 단위 소규모 풀이므로 부담 없음)
  const users = await Promise.all(
    rawUsers.map(async (user) => {
      const groups = await listGroupsForUser(user.Username);
      return {
        username: user.Username,
        name: getAttribute(user.Attributes, 'name'),
        family_id: findFamilyGroup(groups),
        role: groups.find((group) => ROLE_GROUPS.includes(group)) ?? null,
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
 * 사용자의 역할 그룹(Parents/Children)을 변경한다.
 * 가족 그룹 멤버십은 그대로 유지하고, 역할 그룹만 교체한다.
 *
 * admin 계정은 생성/삭제뿐 아니라 역할 변경도 scripts 로만 가능하므로,
 * 대상이 이미 admin 이거나 newGroup 이 admin 이면 거부한다.
 *
 * @param {string} username 대상 사용자 이름
 * @param {string} newGroup 변경할 역할 그룹 (Parents/Children)
 * @returns {Promise<{username: string, group: string}>}
 */
export async function changeUserGroup(username, newGroup) {
  if (!VALID_GROUPS.includes(newGroup)) {
    throw new HttpError(
      400,
      `group 값은 ${VALID_GROUPS.join(', ')} 중 하나여야 합니다. admin 권한은 API 로 부여/변경할 수 없습니다.`,
    );
  }

  await ensureUserExists(username);

  try {
    const currentGroups = await listGroupsForUser(username);
    const currentRole = currentGroups.find((group) => ROLE_GROUPS.includes(group));

    if (currentRole === ADMIN_GROUP) {
      throw new HttpError(400, '관리자 계정의 권한은 API 로 변경할 수 없습니다.');
    }

    // 기존 역할 그룹만 제거 (가족 그룹은 그대로 둔다)
    if (currentRole && currentRole !== newGroup) {
      await client.send(
        new AdminRemoveUserFromGroupCommand({
          UserPoolId: USER_POOL_ID,
          Username: username,
          GroupName: currentRole,
        }),
      );
    }

    // 새 역할 그룹에 추가 (이미 속해 있어도 오류 없이 무시됨)
    if (currentRole !== newGroup) {
      await client.send(
        new AdminAddUserToGroupCommand({
          UserPoolId: USER_POOL_ID,
          Username: username,
          GroupName: newGroup,
        }),
      );
    }
  } catch (err) {
    if (err instanceof HttpError) {
      throw err;
    }
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

/**
 * 사용자의 가족 그룹과 역할을 조회한다.
 * @param {string} username 대상 사용자 이름
 * @returns {Promise<{familyId: string|null, role: string|null}>}
 * @throws {HttpError} 존재하지 않으면 404
 */
export async function getUserFamilyAndRole(username) {
  await ensureUserExists(username);
  const groups = await listGroupsForUser(username);
  return {
    familyId: findFamilyGroup(groups),
    role: groups.find((group) => ROLE_GROUPS.includes(group)) ?? null,
  };
}

/**
 * 사용자 계정을 영구 삭제한다. (admin 계정은 이 함수를 호출하는 쪽에서 사전에 차단해야 함)
 * @param {string} username 대상 사용자 이름
 */
export async function deleteUserAccount(username) {
  try {
    await client.send(new AdminDeleteUserCommand({ UserPoolId: USER_POOL_ID, Username: username }));
  } catch (err) {
    translateCognitoError(err);
  }
}

/**
 * 가족 그룹(Cognito Group, 이름 = family_id)을 생성한다.
 * @param {string} familyId 가족 ID
 * @throws {HttpError} 이미 존재하면 409
 */
export async function createFamilyGroup(familyId) {
  try {
    await client.send(
      new CreateGroupCommand({
        UserPoolId: USER_POOL_ID,
        GroupName: familyId,
        Description: `가족 그룹: ${familyId}`,
      }),
    );
  } catch (err) {
    if (err.name === 'GroupExistsException') {
      throw new HttpError(409, '이미 존재하는 가족(그룹)입니다.');
    }
    translateCognitoError(err);
  }
}

/**
 * 가족 그룹을 삭제한다. (Cognito 는 그룹을 삭제하면 소속 사용자의 멤버십만 제거하고
 * 사용자 계정 자체는 남기므로, 호출 전 그룹이 비어 있는지 확인해야 한다.)
 * @param {string} familyId 가족 ID
 */
async function deleteFamilyGroupInternal(familyId) {
  try {
    await client.send(new DeleteGroupCommand({ UserPoolId: USER_POOL_ID, GroupName: familyId }));
  } catch (err) {
    if (err.name === 'ResourceNotFoundException') {
      return; // 이미 삭제됨
    }
    translateCognitoError(err);
  }
}

/**
 * 관리자가 명시적으로 가족 그룹을 삭제한다. (그룹에 사용자가 남아있으면 거부)
 * @param {string} familyId 가족 ID
 * @throws {HttpError} 그룹이 없거나(404) 사용자가 남아있으면(400)
 */
export async function deleteFamilyGroup(familyId) {
  await ensureFamilyGroupExists(familyId);

  const members = await listUsersInGroup(familyId).catch((err) => translateCognitoError(err));

  if (members.length > 0) {
    throw new HttpError(400, '그룹에 사용자가 남아있어 삭제할 수 없습니다. 사용자를 먼저 삭제하세요.');
  }

  await deleteFamilyGroupInternal(familyId);
}

/**
 * 사용자 삭제 후 가족 그룹에 부모(Parents)가 한 명도 남지 않았다면,
 * 남은 자녀 계정을 모두 삭제하고 가족 그룹 자체도 삭제한다.
 *
 * 가족 그룹에 admin 역할 사용자가 포함되어 있으면 정리하지 않는다.
 * (admin 계정 및 admin 의 가족 그룹 소속은 이 흐름으로 절대 건드리지 않음)
 *
 * @param {string} familyId 가족 ID
 * @returns {Promise<{groupDeleted: boolean, removedChildren: string[]}>}
 */
export async function cleanupFamilyGroupIfNoParents(familyId) {
  let members;
  try {
    members = await listUsersInGroup(familyId);
  } catch (err) {
    if (err.name === 'ResourceNotFoundException') {
      return { groupDeleted: false, removedChildren: [] };
    }
    translateCognitoError(err);
  }

  const withRoles = await Promise.all(
    members.map(async (user) => ({
      username: user.Username,
      role: (await listGroupsForUser(user.Username)).find((group) => ROLE_GROUPS.includes(group)),
    })),
  );

  // admin 이 소속된 가족 그룹은 절대 자동 정리하지 않는다 (admin 잠금 방지)
  if (withRoles.some((user) => user.role === ADMIN_GROUP)) {
    return { groupDeleted: false, removedChildren: [] };
  }

  const hasParent = withRoles.some((user) => user.role === PARENTS_GROUP);
  if (hasParent) {
    return { groupDeleted: false, removedChildren: [] };
  }

  // 부모가 한 명도 없음 → 남은 자녀 계정 삭제 후 그룹 삭제
  const removedChildren = [];
  for (const user of withRoles) {
    await deleteUserAccount(user.username);
    removedChildren.push(user.username);
  }
  await deleteFamilyGroupInternal(familyId);

  return { groupDeleted: true, removedChildren };
}
