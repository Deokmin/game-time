#!/usr/bin/env bash
# ==============================================================================
# Cognito 사용자 삭제 스크립트
#
# admin 역할 계정은 API(DELETE /users)로 삭제할 수 없도록 막혀있으며,
# 오직 이 스크립트로만 삭제할 수 있다 (backend/users.js 참고).
# 일반 사용자(부모/자녀)는 API 로도 삭제 가능하지만, 이 스크립트로도 삭제할 수 있다.
#
# 동작:
#   1. 대상 사용자 정보 및 소속 그룹(역할/가족) 조회 (존재 확인 겸 삭제 전 확인용)
#   2. 삭제 여부 확인 (-y 로 생략 가능)
#   3. aws cognito-idp admin-delete-user 로 계정 영구 삭제
#
# 주의: 삭제는 되돌릴 수 없다. DynamoDB 의 가족 단위 게임 시간 데이터는
#       family_id 기준으로 보관되므로 이 스크립트로 삭제되지 않는다.
#       또한 이 스크립트는 가족 그룹의 부모가 모두 없어졌는지 자동으로 정리하지
#       않으므로, admin 이 아닌 사용자 삭제는 가급적 DELETE /users API 를 사용하라.
#
# 사용법:
#   ./delete-user.sh -u <username> [-p <user_pool_id>] [-r <region>] [-y]
#
# 예시:
#   ./delete-user.sh -u admin
#
# user_pool_id 를 생략하면 ../terraform 디렉터리의
# terraform output 에서 자동으로 읽어온다.
# ==============================================================================

set -euo pipefail

# 스크립트 위치 기준 경로 (어디서 실행해도 동일하게 동작)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TERRAFORM_DIR="${SCRIPT_DIR}/../terraform"

# 기본값
USERNAME=""
USER_POOL_ID="${USER_POOL_ID:-}"
AWS_REGION="${AWS_REGION:-}"
SKIP_CONFIRM=false

usage() {
  echo "사용법: $0 -u <username> [-p <user_pool_id>] [-r <region>] [-y]"
  echo ""
  echo "  -u  삭제할 사용자 이름 (필수)"
  echo "  -p  Cognito User Pool ID (생략 시 terraform output 에서 자동 조회)"
  echo "  -r  AWS 리전 (생략 시 AWS CLI 기본 설정 사용)"
  echo "  -y  확인 프롬프트 없이 즉시 삭제"
  exit 1
}

# 옵션 파싱
while getopts "u:p:r:yh" opt; do
  case "${opt}" in
    u) USERNAME="${OPTARG}" ;;
    p) USER_POOL_ID="${OPTARG}" ;;
    r) AWS_REGION="${OPTARG}" ;;
    y) SKIP_CONFIRM=true ;;
    *) usage ;;
  esac
done

# ------------------------------------------------------------------------------
# 입력값 검증
# ------------------------------------------------------------------------------

if [[ -z "${USERNAME}" ]]; then
  echo "[오류] -u <username> 은 필수입니다." >&2
  usage
fi

# AWS CLI 설치 확인
if ! command -v aws >/dev/null 2>&1; then
  echo "[오류] AWS CLI 가 설치되어 있지 않습니다. https://aws.amazon.com/cli/ 참고" >&2
  exit 1
fi

# ------------------------------------------------------------------------------
# User Pool ID 자동 조회 (terraform output)
# ------------------------------------------------------------------------------

if [[ -z "${USER_POOL_ID}" ]]; then
  if command -v terraform >/dev/null 2>&1 && [[ -d "${TERRAFORM_DIR}" ]]; then
    echo "[정보] terraform output 에서 User Pool ID 를 조회합니다..."
    USER_POOL_ID="$(terraform -chdir="${TERRAFORM_DIR}" output -raw cognito_user_pool_id 2>/dev/null || true)"
  fi
fi

if [[ -z "${USER_POOL_ID}" ]]; then
  echo "[오류] User Pool ID 를 찾을 수 없습니다. -p 옵션으로 직접 지정하세요." >&2
  exit 1
fi

# 리전 옵션 구성 (지정된 경우에만 추가)
REGION_ARGS=()
if [[ -n "${AWS_REGION}" ]]; then
  REGION_ARGS=(--region "${AWS_REGION}")
fi

# ------------------------------------------------------------------------------
# 1. 대상 사용자 조회 (존재 확인)
# ------------------------------------------------------------------------------

USER_INFO="$(aws cognito-idp admin-get-user \
  "${REGION_ARGS[@]}" \
  --user-pool-id "${USER_POOL_ID}" \
  --username "${USERNAME}" 2>/dev/null || true)"

if [[ -z "${USER_INFO}" ]]; then
  echo "[오류] 사용자를 찾을 수 없습니다: ${USERNAME}" >&2
  exit 1
fi

GROUPS_INFO="$(aws cognito-idp admin-list-groups-for-user \
  "${REGION_ARGS[@]}" \
  --user-pool-id "${USER_POOL_ID}" \
  --username "${USERNAME}" 2>/dev/null || true)"

GROUP_NAMES="$(printf '%s' "${GROUPS_INFO}" | grep '"GroupName"' | sed -E 's/.*"GroupName": "(.*)".*/\1/' | tr '\n' ' ' || true)"

# ------------------------------------------------------------------------------
# 2. 삭제 확인
# ------------------------------------------------------------------------------

echo "삭제 대상 사용자 이름 : ${USERNAME}"
[[ -n "${GROUP_NAMES}" ]] && echo "소속 그룹(역할/가족)  : ${GROUP_NAMES}"

if [[ "${SKIP_CONFIRM}" != "true" ]]; then
  read -r -p "정말로 이 사용자를 삭제하시겠습니까? 되돌릴 수 없습니다. (yes 입력): " CONFIRM
  if [[ "${CONFIRM}" != "yes" ]]; then
    echo "[정보] 삭제를 취소했습니다."
    exit 0
  fi
fi

# ------------------------------------------------------------------------------
# 3. 사용자 삭제
# ------------------------------------------------------------------------------

echo "[정보] 사용자를 삭제합니다: ${USERNAME}"

aws cognito-idp admin-delete-user \
  "${REGION_ARGS[@]}" \
  --user-pool-id "${USER_POOL_ID}" \
  --username "${USERNAME}"

echo ""
echo "=============================================================="
echo " 사용자 삭제 완료: ${USERNAME}"
echo "=============================================================="
