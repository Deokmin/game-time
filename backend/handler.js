// ==============================================================================
// Lambda 진입점 - 라우팅 전용
//
// API Gateway HTTP API (Payload v2.0) 의 routeKey 를 기준으로
// 각 비즈니스 로직 모듈에 요청을 위임한다.
// ==============================================================================

import { getGameTime, postGameTime, getGameTimeEvents } from './game-time.js';
import {
  handleListUsers,
  handleCreateUser,
  handleDeleteUser,
  handleChangeGroup,
  handleChangeStatus,
  handleResetPassword,
} from './users.js';
import { handleCreateGroup, handleDeleteGroup } from './groups.js';
import { error } from './response.js';
import { HttpError } from './utils.js';

// routeKey → 핸들러 매핑 테이블
const routes = {
  'GET /game-time': getGameTime,
  'POST /game-time': postGameTime,
  'GET /game-time/events': getGameTimeEvents,
  'GET /users': handleListUsers,
  'POST /users': handleCreateUser,
  'DELETE /users': handleDeleteUser,
  'PATCH /users/group': handleChangeGroup,
  'PATCH /users/status': handleChangeStatus,
  'POST /reset-password': handleResetPassword,
  'POST /groups': handleCreateGroup,
  'DELETE /groups': handleDeleteGroup,
};

/**
 * Lambda 핸들러
 * @param {object} event API Gateway HTTP API 이벤트 (Payload v2.0)
 * @returns {Promise<object>} API Gateway 프록시 응답
 */
export async function handler(event) {
  try {
    const routeHandler = routes[event.routeKey];

    if (!routeHandler) {
      return error(404, '요청한 경로를 찾을 수 없습니다.');
    }

    return await routeHandler(event);
  } catch (err) {
    // 애플리케이션에서 의도적으로 발생시킨 오류 (검증 실패, 권한 부족 등)
    if (err instanceof HttpError) {
      return error(err.statusCode, err.message);
    }

    // 예기치 못한 오류: 내부 정보는 로그에만 남기고, 응답에는 노출하지 않음
    console.error('처리되지 않은 오류:', err);
    return error(500, '서버 내부 오류가 발생했습니다. 잠시 후 다시 시도하세요.');
  }
}
