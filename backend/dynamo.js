// ==============================================================================
// DynamoDB 접근 모듈
//
// 원칙:
//   - Scan 은 절대 사용하지 않는다. 항상 family_id 를 PK 조건으로 Query 한다.
//   - 게임 시간 변경은 TransactWriteItems 로 잔여 시간 갱신과 이력 기록의
//     원자성을 보장한다.
// ==============================================================================

import { randomUUID } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  QueryCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import { HttpError } from './utils.js';

// 환경변수에서 테이블 이름 로드 (하드코딩 금지)
const GAME_TIME_TABLE = process.env.GAME_TIME_TABLE;
const EVENTS_TABLE = process.env.EVENTS_TABLE;

// DocumentClient 는 Lambda 실행 환경(컨테이너) 당 1회만 생성하여 재사용
const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client, {
  marshallOptions: {
    // undefined 속성은 저장하지 않음
    removeUndefinedValues: true,
  },
});

// 이벤트 SK 접두사
const EVENT_SK_PREFIX = 'EVENT#';

/**
 * 가족의 자녀별 현재 남은 게임 시간을 모두 조회한다.
 * @param {string} familyId JWT 에서 추출한 가족 ID
 * @returns {Promise<Array<{family_id: string, child_name: string, remaining_minutes: number, updated_at: string}>>}
 */
export async function getFamilyGameTimes(familyId) {
  const items = [];
  let lastEvaluatedKey;

  // 페이지네이션을 고려하여 모든 결과를 수집 (가족 단위 데이터라 소량)
  do {
    const result = await docClient.send(
      new QueryCommand({
        TableName: GAME_TIME_TABLE,
        KeyConditionExpression: 'family_id = :familyId',
        ExpressionAttributeValues: {
          ':familyId': familyId,
        },
        ExclusiveStartKey: lastEvaluatedKey,
      }),
    );

    items.push(...(result.Items ?? []));
    lastEvaluatedKey = result.LastEvaluatedKey;
  } while (lastEvaluatedKey);

  return items;
}

/**
 * 가족의 게임 시간 변경 이력을 모두 조회한다. (최신순)
 * @param {string} familyId JWT 에서 추출한 가족 ID
 * @returns {Promise<Array<object>>} 이벤트 목록
 */
export async function getFamilyEvents(familyId) {
  const items = [];
  let lastEvaluatedKey;

  do {
    const result = await docClient.send(
      new QueryCommand({
        TableName: EVENTS_TABLE,
        KeyConditionExpression: 'family_id = :familyId AND begins_with(sk, :prefix)',
        ExpressionAttributeValues: {
          ':familyId': familyId,
          ':prefix': EVENT_SK_PREFIX,
        },
        // 최신 이벤트부터 반환 (SK 가 ISO 타임스탬프라 사전순 = 시간순)
        ScanIndexForward: false,
        ExclusiveStartKey: lastEvaluatedKey,
      }),
    );

    items.push(...(result.Items ?? []));
    lastEvaluatedKey = result.LastEvaluatedKey;
  } while (lastEvaluatedKey);

  return items;
}

/**
 * 게임 시간을 추가(SAVE)하거나 차감(USE)한다.
 *
 * DynamoDB 트랜잭션으로 다음 두 작업의 원자성을 보장한다.
 *   1. FamilyGameTime.remaining_minutes 갱신 (UpdateItem)
 *   2. FamilyGameTimeEvents 에 변경 이력 기록 (PutItem)
 *
 * USE 의 경우 잔여 시간이 부족하면 ConditionExpression 에 의해
 * 트랜잭션 전체가 취소된다.
 *
 * @param {object} params
 * @param {string} params.familyId 가족 ID (JWT 에서 추출)
 * @param {string} params.childName 자녀 이름
 * @param {'SAVE'|'USE'} params.actionType 추가/차감 구분
 * @param {number} params.minutes 변경할 분 (양의 정수)
 * @param {string} params.description 변경 사유
 * @param {string} params.targetDate 대상 날짜 (YYYY-MM-DD)
 * @param {string} params.createdBy 요청 사용자 이름 (JWT 에서 추출)
 * @returns {Promise<object>} 기록된 이벤트 항목
 */
export async function applyGameTimeChange({
  familyId,
  childName,
  actionType,
  minutes,
  description,
  targetDate,
  createdBy,
}) {
  const now = new Date().toISOString();
  const eventId = randomUUID();

  // SAVE 는 증가, USE 는 감소
  const delta = actionType === 'SAVE' ? minutes : -minutes;

  // 이력 테이블에 저장할 이벤트 항목
  const eventItem = {
    family_id: familyId,
    // SK: EVENT#<생성시각>#<UUID> - 시간순 정렬 + 동시 요청 충돌 방지
    sk: `${EVENT_SK_PREFIX}${now}#${eventId}`,
    id: eventId,
    child_name: childName,
    action_type: actionType,
    minutes,
    description,
    target_date: targetDate,
    created_by: createdBy,
    created_at: now,
  };

  // 잔여 시간 갱신 파라미터
  const updateParams = {
    TableName: GAME_TIME_TABLE,
    Key: {
      family_id: familyId,
      child_name: childName,
    },
    // ADD 는 항목이 없으면 0에서 시작하여 새로 생성함 (SAVE 시 자동 생성)
    UpdateExpression: 'SET updated_at = :now ADD remaining_minutes :delta',
    ExpressionAttributeValues: {
      ':now': now,
      ':delta': delta,
    },
  };

  if (actionType === 'USE') {
    // 차감 시: 항목이 존재하고 잔여 시간이 충분해야만 성공
    updateParams.ConditionExpression =
      'attribute_exists(family_id) AND remaining_minutes >= :required';
    updateParams.ExpressionAttributeValues[':required'] = minutes;
  }

  try {
    await docClient.send(
      new TransactWriteCommand({
        TransactItems: [
          { Update: updateParams },
          {
            Put: {
              TableName: EVENTS_TABLE,
              Item: eventItem,
              // 동일 키 중복 기록 방지 (UUID 포함이라 사실상 발생하지 않음)
              ConditionExpression: 'attribute_not_exists(sk)',
            },
          },
        ],
      }),
    );
  } catch (err) {
    // 조건 실패(잔여 시간 부족) 시 트랜잭션이 취소됨
    if (err.name === 'TransactionCanceledException') {
      const conditionFailed = (err.CancellationReasons ?? []).some(
        (reason) => reason?.Code === 'ConditionalCheckFailed',
      );
      if (conditionFailed) {
        throw new HttpError(400, '잔여 게임 시간이 부족하여 차감할 수 없습니다.');
      }
    }
    throw err;
  }

  return eventItem;
}
