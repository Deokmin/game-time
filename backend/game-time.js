// ==============================================================================
// 게임 시간 API 비즈니스 로직
//
//   GET  /game-time         : 가족의 자녀별 남은 게임 시간 조회 (전체 그룹)
//   POST /game-time         : 게임 시간 추가/차감 (admin, Parents 만)
//   GET  /game-time/events  : 게임 시간 변경 이력 조회 (전체 그룹)
//
// 모든 데이터 접근은 JWT Claim 의 family_id 로 제한된다.
// 다른 가족의 데이터는 절대 조회/수정할 수 없다.
// ==============================================================================

import {
  getAuthContext,
  requireGroup,
  ADMIN_GROUP,
  PARENTS_GROUP,
  CHILDREN_GROUP,
} from './auth.js';
import { getFamilyGameTimes, getFamilyEvents, applyGameTimeChange } from './dynamo.js';
import { ok, created } from './response.js';
import {
  HttpError,
  ACTION_TYPES,
  parseJsonBody,
  requireString,
  requireDateString,
  requireMinutes,
} from './utils.js';

/**
 * GET /game-time
 * 가족의 자녀별 현재 남은 게임 시간을 조회한다.
 * 허용 그룹: admin, Parents, Children (조회는 전체 허용)
 */
export async function getGameTime(event) {
  const auth = getAuthContext(event);
  requireGroup(auth, [ADMIN_GROUP, PARENTS_GROUP, CHILDREN_GROUP]);

  // 반드시 본인 가족의 데이터만 조회 (family_id 는 JWT 에서만 가져옴)
  const items = await getFamilyGameTimes(auth.familyId);

  return ok({
    family_id: auth.familyId,
    game_times: items.map((item) => ({
      child_name: item.child_name,
      remaining_minutes: item.remaining_minutes,
      updated_at: item.updated_at,
    })),
  });
}

/**
 * POST /game-time
 * 게임 시간을 추가(SAVE)하거나 차감(USE)한다.
 * 허용 그룹: admin, Parents (Children 은 403)
 *
 * 요청 본문:
 *   - child_name  : 자녀 이름 (필수)
 *   - action_type : SAVE | USE (필수)
 *   - minutes     : 변경할 분, 1~1440 정수 (필수)
 *   - description : 변경 사유 (필수)
 *   - target_date : 대상 날짜 YYYY-MM-DD (필수)
 */
export async function postGameTime(event) {
  const auth = getAuthContext(event);

  // Children 은 조회만 가능 - 변경 요청은 403 Forbidden
  requireGroup(auth, [ADMIN_GROUP, PARENTS_GROUP]);

  const body = parseJsonBody(event);

  // 입력값 검증
  const childName = requireString(body.child_name, 'child_name', 50);
  const actionType = body.action_type;
  if (!ACTION_TYPES.includes(actionType)) {
    throw new HttpError(400, `action_type 값은 ${ACTION_TYPES.join(', ')} 중 하나여야 합니다.`);
  }
  const minutes = requireMinutes(body.minutes);
  const description = requireString(body.description, 'description', 200);
  const targetDate = requireDateString(body.target_date, 'target_date');

  // 트랜잭션으로 잔여 시간 갱신 + 이력 기록 (원자성 보장)
  const eventItem = await applyGameTimeChange({
    familyId: auth.familyId, // 반드시 JWT 의 family_id 사용 (본문 값 무시)
    childName,
    actionType,
    minutes,
    description,
    targetDate,
    createdBy: auth.username,
  });

  return created({
    message: actionType === 'SAVE' ? '게임 시간이 추가되었습니다.' : '게임 시간이 차감되었습니다.',
    event: {
      id: eventItem.id,
      child_name: eventItem.child_name,
      action_type: eventItem.action_type,
      minutes: eventItem.minutes,
      description: eventItem.description,
      target_date: eventItem.target_date,
      created_by: eventItem.created_by,
      created_at: eventItem.created_at,
    },
  });
}

/**
 * GET /game-time/events
 * 가족의 게임 시간 변경 이력을 조회한다. (달력 표시용)
 * 허용 그룹: admin, Parents, Children (조회는 전체 허용)
 */
export async function getGameTimeEvents(event) {
  const auth = getAuthContext(event);
  requireGroup(auth, [ADMIN_GROUP, PARENTS_GROUP, CHILDREN_GROUP]);

  const items = await getFamilyEvents(auth.familyId);

  return ok({
    family_id: auth.familyId,
    events: items.map((item) => ({
      id: item.id,
      child_name: item.child_name,
      action_type: item.action_type,
      minutes: item.minutes,
      description: item.description,
      target_date: item.target_date,
      created_by: item.created_by,
      created_at: item.created_at,
    })),
  });
}
