// ==============================================================================
// 공통 HTTP 응답 생성 모듈
//
// 참고: CORS 헤더는 API Gateway HTTP API 의 cors_configuration 이 자동으로
//       추가하므로 Lambda 응답에는 중복으로 넣지 않는다.
//       (중복 시 브라우저가 CORS 오류를 발생시킬 수 있음)
// ==============================================================================

/**
 * JSON 응답을 생성한다.
 * @param {number} statusCode HTTP 상태 코드
 * @param {object} body 응답 본문 객체
 * @returns {object} API Gateway 프록시(v2.0) 응답 객체
 */
export function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      // 보안 헤더: 응답의 MIME 타입 추측 차단
      'X-Content-Type-Options': 'nosniff',
    },
    body: JSON.stringify(body),
  };
}

/**
 * 성공(200) 응답을 생성한다.
 * @param {object} data 응답 데이터
 */
export function ok(data) {
  return json(200, data);
}

/**
 * 생성 성공(201) 응답을 생성한다.
 * @param {object} data 응답 데이터
 */
export function created(data) {
  return json(201, data);
}

/**
 * 오류 응답을 생성한다.
 * @param {number} statusCode HTTP 상태 코드
 * @param {string} message 사용자에게 표시할 오류 메시지
 */
export function error(statusCode, message) {
  return json(statusCode, { message });
}
