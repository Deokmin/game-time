# ==============================================================================
# 로컬 변수 정의 (프로젝트 전체에서 일관된 이름 사용)
# ==============================================================================

locals {
  # 리소스 이름 접두사
  name_prefix = var.project_name

  # DynamoDB 테이블 이름 (요구사항에 정의된 고정 이름)
  game_time_table_name = "FamilyGameTime"
  events_table_name    = "FamilyGameTimeEvents"

  # Lambda 함수 이름
  lambda_function_name = "${local.name_prefix}-api"

  # Cognito 사용자 그룹 이름 (백엔드/프론트엔드와 반드시 일치해야 함)
  cognito_groups = {
    admin    = "admin"
    parents  = "Parents"
    children = "Children"
  }

  # 모든 리소스에 적용할 공통 태그
  common_tags = {
    Project   = var.project_name
    ManagedBy = "terraform"
  }
}
