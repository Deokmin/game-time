// ==============================================================================
// 공통 유틸리티 모듈 (입력값 검증, 오류 클래스, 임시 비밀번호 생성 등)
// ==============================================================================

import { randomInt } from 'node:crypto';

/**
 * HTTP 상태 코드를 포함하는 애플리케이션 오류.
 * handler.js 의 최상위 catch 에서 상태 코드/메시지로 변환된다.
 */
export class HttpError extends Error {
  /**
   * @param {number} statusCode HTTP 상태 코드
   * @param {string} message 사용자에게 표시할 메시지
   */
  constructor(statusCode, message) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
  }
}

// 액션 타입 상수 (프론트엔드/데이터 모델과 일치)
export const ACTION_TYPES = Object.freeze(['SAVE', 'USE']);

// 게임 시간 1회 변경 최대 분 (하루 = 1440분)
export const MAX_MINUTES_PER_CHANGE = 1440;

/**
 * API Gateway 이벤트의 body 를 안전하게 JSON 파싱한다.
 * @param {object} event API Gateway 이벤트
 * @returns {object} 파싱된 본문 객체
 * @throws {HttpError} 본문이 없거나 JSON 이 아닐 경우 400
 */
export function parseJsonBody(event) {
  if (!event.body) {
    throw new HttpError(400, '요청 본문이 비어 있습니다.');
  }

  let raw = event.body;

  // HTTP API 는 바이너리 본문을 base64 로 인코딩할 수 있음
  if (event.isBase64Encoded) {
    raw = Buffer.from(raw, 'base64').toString('utf-8');
  }

  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('본문은 JSON 객체여야 합니다.');
    }
    return parsed;
  } catch {
    throw new HttpError(400, '요청 본문이 올바른 JSON 형식이 아닙니다.');
  }
}

/**
 * 값이 비어 있지 않은 문자열인지 검사한다.
 * @param {*} value 검사할 값
 * @param {number} maxLength 최대 길이
 */
export function isNonEmptyString(value, maxLength = 200) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength;
}

/**
 * 필수 문자열 필드를 검증하고 trim 된 값을 반환한다.
 * @param {*} value 검사할 값
 * @param {string} fieldName 필드 이름 (오류 메시지용)
 * @param {number} maxLength 최대 길이
 * @returns {string} trim 된 문자열
 * @throws {HttpError} 유효하지 않으면 400
 */
export function requireString(value, fieldName, maxLength = 200) {
  if (!isNonEmptyString(value, maxLength)) {
    throw new HttpError(400, `${fieldName} 값이 올바르지 않습니다. (1~${maxLength}자 문자열 필수)`);
  }
  return value.trim();
}

/**
 * YYYY-MM-DD 형식의 날짜 문자열인지 검증한다.
 * @param {*} value 검사할 값
 * @param {string} fieldName 필드 이름 (오류 메시지용)
 * @returns {string} 검증된 날짜 문자열
 * @throws {HttpError} 유효하지 않으면 400
 */
export function requireDateString(value, fieldName) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new HttpError(400, `${fieldName} 값은 YYYY-MM-DD 형식이어야 합니다.`);
  }

  // 실제 존재하는 날짜인지 확인 (예: 2026-02-30 차단)
  const date = new Date(`${value}T00:00:00Z`);
  const [year, month, day] = value.split('-').map(Number);
  if (
    Number.isNaN(date.getTime()) ||
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() + 1 !== month ||
    date.getUTCDate() !== day
  ) {
    throw new HttpError(400, `${fieldName} 값이 실제 존재하는 날짜가 아닙니다.`);
  }

  return value;
}

/**
 * 게임 시간(분) 값을 검증한다. (1 이상의 정수, 하루 이내)
 * @param {*} value 검사할 값
 * @returns {number} 검증된 정수 분
 * @throws {HttpError} 유효하지 않으면 400
 */
export function requireMinutes(value) {
  if (!Number.isInteger(value) || value < 1 || value > MAX_MINUTES_PER_CHANGE) {
    throw new HttpError(400, `minutes 값은 1 이상 ${MAX_MINUTES_PER_CHANGE} 이하의 정수여야 합니다.`);
  }
  return value;
}

/**
 * Cognito 사용자 이름 형식을 검증한다.
 * (영문/숫자/점/밑줄/하이픈, 3~30자 - 이메일 형식 사용자명은 허용하지 않음)
 * @param {*} value 검사할 값
 * @returns {string} 검증된 사용자 이름
 * @throws {HttpError} 유효하지 않으면 400
 */
export function requireUsername(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9._-]{3,30}$/.test(value)) {
    throw new HttpError(400, 'username 은 영문/숫자/._- 조합의 3~30자여야 합니다.');
  }
  return value;
}

/**
 * family_id 형식을 검증한다. (영문 소문자/숫자/하이픈, 1~64자)
 * @param {*} value 검사할 값
 * @returns {string} 검증된 family_id
 * @throws {HttpError} 유효하지 않으면 400
 */
export function requireFamilyId(value) {
  if (typeof value !== 'string' || !/^[a-z0-9-]{1,64}$/.test(value)) {
    throw new HttpError(400, 'family_id 는 영문 소문자/숫자/하이픈 조합의 1~64자여야 합니다.');
  }
  return value;
}

/**
 * Cognito 비밀번호 정책(8자 이상, 대문자/소문자/숫자 포함)을 만족하는
 * 랜덤 임시 비밀번호를 생성한다. crypto.randomInt 로 예측 불가능성 보장.
 * @returns {string} 임시 비밀번호 (12자)
 */
export function generateTempPassword() {
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // 혼동되는 I, O 제외
  const lower = 'abcdefghijkmnpqrstuvwxyz'; // 혼동되는 l, o 제외
  const digits = '23456789'; // 혼동되는 0, 1 제외
  const all = upper + lower + digits;

  const pick = (chars) => chars[randomInt(chars.length)];

  // 각 문자 종류를 최소 1개씩 보장
  const chars = [pick(upper), pick(lower), pick(digits)];

  // 나머지 9자는 전체 문자 집합에서 랜덤 선택 (총 12자)
  for (let i = 0; i < 9; i += 1) {
    chars.push(pick(all));
  }

  // Fisher-Yates 셔플로 문자 위치 무작위화
  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }

  return chars.join('');
}
