#!/usr/bin/env bash
# ==============================================================================
# 최초 admin 계정 생성 스크립트
#
# Terraform 은 User Pool / Client 만 생성하며, admin 계정은 이 스크립트로만
# 생성한다. (Terraform state 에 비밀번호가 저장되지 않도록 하기 위함이며,
# API 로는 admin 계정을 생성할 수 없도록 의도적으로 막혀있다 - backend/cognito.js)
#
# 동작:
#   1. 랜덤 임시 비밀번호 생성
#   2. (-f 지정 시) 가족 그룹(이름=family_id)이 없으면 생성 (이미 있으면 그대로 사용)
#   3. aws cognito-idp admin-create-user 로 admin 계정 생성
#      (MessageAction=SUPPRESS - 이메일/SMS 발송 없음)
#   4. admin 그룹에 추가하고, -f 지정 시 가족 그룹에도 추가
#      (가족 범위는 커스텀 속성이 아니라 그룹 멤버십으로 결정된다 - backend/auth.js)
#
# admin 은 가족 그룹 없이도 인증/관리가 가능하다 (-f 생략 가능).
# 단, 가족이 없는 admin 은 본인 대시보드에 표시할 게임 시간 데이터가 없다.
#
# 임시 비밀번호로 최초 로그인하면 NEW_PASSWORD_REQUIRED Challenge 가 발생하여
# 웹 화면에서 새 비밀번호를 설정하게 된다.
#
# 사용법:
#   ./create-admin.sh -u <username> [-f <family_id>] [-n <이름>] [-p <user_pool_id>] [-r <region>]
#
# 예시:
#   ./create-admin.sh -u admin -f kim-family -n "관리자"
#   ./create-admin.sh -u superadmin -n "전체 관리자"   # 가족 없는 관리 전용 계정
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
FAMILY_ID=""
DISPLAY_NAME="관리자"
USER_POOL_ID="${USER_POOL_ID:-}"
AWS_REGION="${AWS_REGION:-}"

usage() {
  echo "사용법: $0 -u <username> [-f <family_id>] [-n <이름>] [-p <user_pool_id>] [-r <region>]"
  echo ""
  echo "  -u  admin 계정의 사용자 이름 (필수, 영문/숫자/._- 3~30자)"
  echo "  -f  가족 ID (선택, 영문 소문자/숫자/하이픈 1~64자 - 생략 시 가족 없는 관리 전용 계정)"
  echo "  -n  표시 이름 (기본값: 관리자)"
  echo "  -p  Cognito User Pool ID (생략 시 terraform output 에서 자동 조회)"
  echo "  -r  AWS 리전 (생략 시 AWS CLI 기본 설정 사용)"
  exit 1
}

# 옵션 파싱
while getopts "u:f:n:p:r:h" opt; do
  case "${opt}" in
    u) USERNAME="${OPTARG}" ;;
    f) FAMILY_ID="${OPTARG}" ;;
    n) DISPLAY_NAME="${OPTARG}" ;;
    p) USER_POOL_ID="${OPTARG}" ;;
    r) AWS_REGION="${OPTARG}" ;;
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

if ! [[ "${USERNAME}" =~ ^[a-zA-Z0-9._-]{3,30}$ ]]; then
  echo "[오류] username 은 영문/숫자/._- 조합의 3~30자여야 합니다." >&2
  exit 1
fi

# family_id 는 선택 사항 - 지정된 경우에만 검증
if [[ -n "${FAMILY_ID}" ]]; then
  if ! [[ "${FAMILY_ID}" =~ ^[a-z0-9-]{1,64}$ ]]; then
    echo "[오류] family_id 는 영문 소문자/숫자/하이픈 조합의 1~64자여야 합니다." >&2
    exit 1
  fi

  # family_id 는 그대로 Cognito 그룹 이름이 되므로 역할 그룹 이름(admin)과 충돌할 수 없음
  if [[ "${FAMILY_ID}" == "admin" ]]; then
    echo "[오류] family_id 로 'admin' 은 사용할 수 없습니다 (역할 그룹 이름과 충돌)." >&2
    exit 1
  fi
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
# 랜덤 임시 비밀번호 생성
# (Cognito 정책: 6자 이상, 소문자/숫자 포함 - 여기서는 16자 생성)
# ------------------------------------------------------------------------------

generate_password() {
  local lower digits rest
  # LC_ALL=C 로 바이트 단위 처리 보장, /dev/urandom 으로 예측 불가능성 확보
  lower="$(LC_ALL=C tr -dc 'a-km-z' < /dev/urandom | head -c 3)"
  digits="$(LC_ALL=C tr -dc '2-9' < /dev/urandom | head -c 3)"
  rest="$(LC_ALL=C tr -dc 'a-km-z2-9' < /dev/urandom | head -c 10)"
  # fold 로 한 글자씩 분리 후 shuf 로 섞어 위치 무작위화
  printf '%s' "${lower}${digits}${rest}" | fold -w1 | shuf | tr -d '\n'
}

TEMP_PASSWORD="$(generate_password)"

# ------------------------------------------------------------------------------
# 1. 가족 그룹 확인/생성 (이름 = family_id, -f 지정 시에만)
# ------------------------------------------------------------------------------

if [[ -n "${FAMILY_ID}" ]]; then
  if aws cognito-idp get-group \
    "${REGION_ARGS[@]}" \
    --user-pool-id "${USER_POOL_ID}" \
    --group-name "${FAMILY_ID}" > /dev/null 2>&1; then
    echo "[정보] 가족 그룹이 이미 존재합니다: ${FAMILY_ID}"
  else
    echo "[정보] 가족 그룹을 생성합니다: ${FAMILY_ID}"
    aws cognito-idp create-group \
      "${REGION_ARGS[@]}" \
      --user-pool-id "${USER_POOL_ID}" \
      --group-name "${FAMILY_ID}" \
      --description "가족 그룹: ${FAMILY_ID}" \
      > /dev/null
  fi
fi

# ------------------------------------------------------------------------------
# 2. admin 계정 생성 (이메일/SMS 발송 억제)
# ------------------------------------------------------------------------------

echo "[정보] admin 계정을 생성합니다: ${USERNAME} (family_id=${FAMILY_ID:-없음})"

aws cognito-idp admin-create-user \
  "${REGION_ARGS[@]}" \
  --user-pool-id "${USER_POOL_ID}" \
  --username "${USERNAME}" \
  --temporary-password "${TEMP_PASSWORD}" \
  --message-action SUPPRESS \
  --user-attributes \
    Name=name,Value="${DISPLAY_NAME}" \
  > /dev/null

# ------------------------------------------------------------------------------
# 3. admin 그룹에 추가하고, -f 지정 시 가족 그룹에도 추가
#    (admin 은 가족 그룹 없이도 인증 가능 - backend/auth.js)
# ------------------------------------------------------------------------------

echo "[정보] admin 그룹에 추가합니다..."

aws cognito-idp admin-add-user-to-group \
  "${REGION_ARGS[@]}" \
  --user-pool-id "${USER_POOL_ID}" \
  --username "${USERNAME}" \
  --group-name admin

if [[ -n "${FAMILY_ID}" ]]; then
  echo "[정보] 가족 그룹에 추가합니다: ${FAMILY_ID}"
  aws cognito-idp admin-add-user-to-group \
    "${REGION_ARGS[@]}" \
    --user-pool-id "${USER_POOL_ID}" \
    --username "${USERNAME}" \
    --group-name "${FAMILY_ID}"
fi

# ------------------------------------------------------------------------------
# 완료 안내
# ------------------------------------------------------------------------------

echo ""
echo "=============================================================="
echo " admin 계정 생성 완료"
echo "=============================================================="
echo " 사용자 이름   : ${USERNAME}"
echo " 가족 ID       : ${FAMILY_ID:-없음 (가족 없는 관리 전용 계정)}"
echo " 임시 비밀번호 : ${TEMP_PASSWORD}"
echo "=============================================================="
echo " * 임시 비밀번호는 다시 확인할 수 없으니 지금 기록하세요."
echo " * 웹사이트에서 최초 로그인하면 새 비밀번호 설정 화면이"
echo "   자동으로 표시됩니다. (NEW_PASSWORD_REQUIRED)"
echo "=============================================================="
