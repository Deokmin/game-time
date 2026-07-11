# ==============================================================================
# 가족 게임 시간 관리 - 전체 인프라 정의
#
# 구성 요소:
#   1. Amazon Cognito (User Pool, Groups, App Client)
#   2. DynamoDB (FamilyGameTime, FamilyGameTimeEvents)
#   3. CloudWatch Logs (보존 7일)
#   4. IAM (Lambda 최소 권한 역할)
#   5. AWS Lambda (Node.js 20.x, arm64 - 비용 최소화)
#   6. API Gateway HTTP API (Cognito JWT Authorizer, CORS)
#   7. S3 Static Website Hosting (SPA)
# ==============================================================================

# 현재 AWS 계정 정보 (S3 버킷 이름의 전역 고유성 확보에 사용)
data "aws_caller_identity" "current" {}

# ------------------------------------------------------------------------------
# 1. Amazon Cognito User Pool
# ------------------------------------------------------------------------------

resource "aws_cognito_user_pool" "this" {
  name = "${local.name_prefix}-user-pool"

  # 삭제 보호 비활성화 (요구사항: 비용/관리 단순화)
  deletion_protection = "INACTIVE"

  # 자가 회원가입 차단 - 오직 관리자(admin-create-user)만 사용자 생성 가능
  admin_create_user_config {
    allow_admin_create_user_only = true
  }

  # 비밀번호 정책 (백엔드 임시 비밀번호 생성 로직과 반드시 일치해야 함)
  # 최소 길이는 Cognito 제약상 6자가 하한선 (4자 설정 불가)
  password_policy {
    minimum_length                   = 6
    require_lowercase                = true
    require_uppercase                = false
    require_numbers                  = true
    require_symbols                  = false
    temporary_password_validity_days = 7
  }

  # 계정 복구는 관리자를 통해서만 가능 (이메일/SMS 발송 비용 원천 차단)
  account_recovery_setting {
    recovery_mechanism {
      name     = "admin_only"
      priority = 1
    }
  }

  # 참고: 가족 구분은 커스텀 속성이 아니라 Cognito 그룹 멤버십으로 이루어진다
  # (그룹 이름 = family_id, backend/auth.js 참고). 이 스키마는 과거 버전과의
  # User Pool 호환성을 위해 남겨두며, 애플리케이션 로직에서는 더 이상 읽지 않는다.
  schema {
    name                     = "family_id"
    attribute_data_type      = "String"
    developer_only_attribute = false
    mutable                  = true
    required                 = false

    string_attribute_constraints {
      min_length = 1
      max_length = 64
    }
  }
}

# 사용자 그룹: admin (모든 권한)
resource "aws_cognito_user_group" "admin" {
  name         = local.cognito_groups.admin
  user_pool_id = aws_cognito_user_pool.this.id
  description  = "관리자 - 사용자 관리 및 게임 시간 관리 전체 권한"
  precedence   = 1
}

# 사용자 그룹: Parents (게임 시간 추가/차감/조회)
resource "aws_cognito_user_group" "parents" {
  name         = local.cognito_groups.parents
  user_pool_id = aws_cognito_user_pool.this.id
  description  = "부모 - 게임 시간 추가/차감/조회 권한"
  precedence   = 2
}

# 사용자 그룹: Children (조회만 가능)
resource "aws_cognito_user_group" "children" {
  name         = local.cognito_groups.children
  user_pool_id = aws_cognito_user_pool.this.id
  description  = "자녀 - 게임 시간 조회 전용 권한"
  precedence   = 3
}

# User Pool Client (브라우저 SPA 용 - 시크릿 없음, SRP 인증)
resource "aws_cognito_user_pool_client" "web" {
  name         = "${local.name_prefix}-web-client"
  user_pool_id = aws_cognito_user_pool.this.id

  # 브라우저에서 사용하므로 클라이언트 시크릿을 생성하지 않음
  generate_secret = false

  # SRP 인증(비밀번호가 네트워크로 전송되지 않음) + 토큰 자동 갱신 허용
  explicit_auth_flows = [
    "ALLOW_USER_SRP_AUTH",
    "ALLOW_REFRESH_TOKEN_AUTH",
  ]

  # 사용자 존재 여부 노출 방지 (보안 - 사용자 열거 공격 차단)
  prevent_user_existence_errors = "ENABLED"

  # 토큰 유효 기간 설정
  access_token_validity  = 60 # 60분
  id_token_validity      = 60 # 60분
  refresh_token_validity = 30 # 30일

  token_validity_units {
    access_token  = "minutes"
    id_token      = "minutes"
    refresh_token = "days"
  }

  # 토큰 폐기(로그아웃 시 GlobalSignOut) 지원
  enable_token_revocation = true
}

# ------------------------------------------------------------------------------
# 2. DynamoDB 테이블
# ------------------------------------------------------------------------------

# 테이블 1: 자녀별 현재 남은 게임 시간
resource "aws_dynamodb_table" "game_time" {
  name         = local.game_time_table_name
  billing_mode = "PAY_PER_REQUEST" # 온디맨드 - 사용량이 거의 없으면 비용도 거의 0원

  hash_key  = "family_id"  # PK: 가족 ID
  range_key = "child_name" # SK: 자녀 이름

  attribute {
    name = "family_id"
    type = "S"
  }

  attribute {
    name = "child_name"
    type = "S"
  }

  # 요구사항: PITR 비활성화 (비용 절감)
  point_in_time_recovery {
    enabled = false
  }

  # 요구사항: 삭제 보호 비활성화
  deletion_protection_enabled = false
}

# 테이블 2: 게임 시간 변경 이력
resource "aws_dynamodb_table" "events" {
  name         = local.events_table_name
  billing_mode = "PAY_PER_REQUEST"

  hash_key  = "family_id" # PK: 가족 ID
  range_key = "sk"        # SK: "EVENT#<ISO타임스탬프>#<고유ID>" 형식

  attribute {
    name = "family_id"
    type = "S"
  }

  attribute {
    name = "sk"
    type = "S"
  }

  point_in_time_recovery {
    enabled = false
  }

  deletion_protection_enabled = false
}

# ------------------------------------------------------------------------------
# 3. CloudWatch Logs (Lambda 로그 그룹, 보존 7일)
# ------------------------------------------------------------------------------

resource "aws_cloudwatch_log_group" "lambda" {
  name              = "/aws/lambda/${local.lambda_function_name}"
  retention_in_days = var.log_retention_days
}

# ------------------------------------------------------------------------------
# 4. IAM - Lambda 실행 역할 (최소 권한 원칙)
# ------------------------------------------------------------------------------

# Lambda 서비스가 이 역할을 Assume 할 수 있도록 하는 신뢰 정책
data "aws_iam_policy_document" "lambda_assume" {
  statement {
    sid     = "LambdaAssumeRole"
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "lambda" {
  name               = "${local.name_prefix}-lambda-role"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

# Lambda 권한 정책 - 와일드카드(*) 리소스를 사용하지 않고 필요한 ARN 만 명시
data "aws_iam_policy_document" "lambda_permissions" {
  # DynamoDB: 두 테이블에 대해 필요한 동작만 허용
  # 참고: TransactWriteItems 호출은 IAM 상에서 별도 액션이 아니라
  #       트랜잭션에 포함된 개별 항목의 PutItem / UpdateItem /
  #       ConditionCheckItem 권한으로 평가된다.
  statement {
    sid    = "DynamoDbTableAccess"
    effect = "Allow"

    actions = [
      "dynamodb:Query",
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
      "dynamodb:ConditionCheckItem",
    ]

    resources = [
      aws_dynamodb_table.game_time.arn,
      aws_dynamodb_table.events.arn,
    ]
  }

  # Cognito: 사용자 관리 API 에서 사용하는 관리자 동작만 허용 (해당 User Pool 한정)
  statement {
    sid    = "CognitoUserManagement"
    effect = "Allow"

    actions = [
      "cognito-idp:AdminCreateUser",
      "cognito-idp:AdminDeleteUser",
      "cognito-idp:AdminAddUserToGroup",
      "cognito-idp:AdminRemoveUserFromGroup",
      "cognito-idp:AdminListGroupsForUser",
      "cognito-idp:AdminDisableUser",
      "cognito-idp:AdminEnableUser",
      "cognito-idp:AdminSetUserPassword",
      "cognito-idp:AdminGetUser",
      "cognito-idp:ListUsers",
      "cognito-idp:ListUsersInGroup",
      "cognito-idp:CreateGroup",
      "cognito-idp:DeleteGroup",
      "cognito-idp:GetGroup",
    ]

    resources = [
      aws_cognito_user_pool.this.arn,
    ]
  }

  # CloudWatch Logs: 미리 생성한 로그 그룹의 스트림에만 기록 허용
  statement {
    sid    = "LambdaLogging"
    effect = "Allow"

    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]

    resources = [
      "${aws_cloudwatch_log_group.lambda.arn}:*",
    ]
  }
}

resource "aws_iam_role_policy" "lambda" {
  name   = "${local.name_prefix}-lambda-policy"
  role   = aws_iam_role.lambda.id
  policy = data.aws_iam_policy_document.lambda_permissions.json
}

# ------------------------------------------------------------------------------
# 5. AWS Lambda (Node.js 20.x)
# ------------------------------------------------------------------------------

# backend 디렉터리 전체를 ZIP 으로 패키징
# (AWS SDK v3 는 nodejs20.x 런타임에 기본 포함되므로 node_modules 불필요)
data "archive_file" "lambda" {
  type        = "zip"
  source_dir  = "${path.module}/../backend"
  output_path = "${path.module}/build/lambda.zip"

  excludes = [
    "node_modules",
    "package-lock.json",
  ]
}

resource "aws_lambda_function" "api" {
  function_name = local.lambda_function_name
  description   = "가족 게임 시간 관리 API (단일 Lambda 라우팅)"

  role    = aws_iam_role.lambda.arn
  runtime = "nodejs20.x"
  handler = "handler.handler"

  # arm64(Graviton) 아키텍처 - x86 대비 저렴하고 성능 우수
  architectures = ["arm64"]

  filename         = data.archive_file.lambda.output_path
  source_code_hash = data.archive_file.lambda.output_base64sha256

  memory_size = var.lambda_memory_size
  timeout     = var.lambda_timeout

  # 백엔드 코드에서 사용하는 환경변수 (하드코딩 금지 원칙)
  environment {
    variables = {
      USER_POOL_ID    = aws_cognito_user_pool.this.id
      GAME_TIME_TABLE = aws_dynamodb_table.game_time.name
      EVENTS_TABLE    = aws_dynamodb_table.events.name
      ADMIN_GROUP     = local.cognito_groups.admin
      PARENTS_GROUP   = local.cognito_groups.parents
      CHILDREN_GROUP  = local.cognito_groups.children
    }
  }

  # 로그 그룹을 Terraform 이 먼저 생성하도록 의존성 명시
  # (Lambda 가 임의로 로그 그룹을 만들지 않도록 CreateLogGroup 권한도 미부여)
  depends_on = [aws_cloudwatch_log_group.lambda]
}

# ------------------------------------------------------------------------------
# 6. API Gateway HTTP API
# ------------------------------------------------------------------------------

resource "aws_apigatewayv2_api" "this" {
  name          = "${local.name_prefix}-http-api"
  protocol_type = "HTTP"
  description   = "가족 게임 시간 관리 HTTP API"

  # CORS: S3 정적 웹사이트 Origin 만 허용 (S3 웹사이트 엔드포인트는 http 전용)
  cors_configuration {
    allow_origins = ["http://${aws_s3_bucket_website_configuration.frontend.website_endpoint}"]
    allow_methods = ["GET", "POST", "PATCH", "DELETE", "OPTIONS"]
    allow_headers = ["authorization", "content-type"]
    max_age       = 3600
  }
}

# Cognito JWT Authorizer - ID 토큰 검증 (aud = User Pool Client ID)
resource "aws_apigatewayv2_authorizer" "cognito" {
  api_id           = aws_apigatewayv2_api.this.id
  name             = "${local.name_prefix}-cognito-authorizer"
  authorizer_type  = "JWT"
  identity_sources = ["$request.header.Authorization"]

  jwt_configuration {
    audience = [aws_cognito_user_pool_client.web.id]
    issuer   = "https://cognito-idp.${var.aws_region}.amazonaws.com/${aws_cognito_user_pool.this.id}"
  }
}

# Lambda 프록시 통합 (Payload v2.0)
resource "aws_apigatewayv2_integration" "lambda" {
  api_id                 = aws_apigatewayv2_api.this.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.api.invoke_arn
  payload_format_version = "2.0"
}

# 모든 라우트는 Cognito JWT Authorizer 로 보호됨
resource "aws_apigatewayv2_route" "protected" {
  for_each = toset([
    "GET /game-time",
    "POST /game-time",
    "GET /game-time/events",
    "GET /users",
    "POST /users",
    "DELETE /users",
    "PATCH /users/group",
    "PATCH /users/status",
    "POST /reset-password",
    "POST /groups",
    "DELETE /groups",
  ])

  api_id             = aws_apigatewayv2_api.this.id
  route_key          = each.value
  target             = "integrations/${aws_apigatewayv2_integration.lambda.id}"
  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.cognito.id
}

# $default 스테이지 (자동 배포)
resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.this.id
  name        = "$default"
  auto_deploy = true
}

# API Gateway 가 Lambda 를 호출할 수 있도록 권한 부여
resource "aws_lambda_permission" "apigw" {
  statement_id  = "AllowApiGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.api.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.this.execution_arn}/*/*"
}

# ------------------------------------------------------------------------------
# 7. S3 Static Website Hosting (프론트엔드 SPA)
# ------------------------------------------------------------------------------

resource "aws_s3_bucket" "frontend" {
  # 계정 ID 를 붙여 전역 고유 버킷 이름 보장
  bucket = "${local.name_prefix}-frontend-${data.aws_caller_identity.current.account_id}"

  # terraform destroy 시 객체가 있어도 버킷 삭제 가능
  force_destroy = true
}

# 정적 웹사이트 호스팅은 퍼블릭 읽기가 필요하므로 퍼블릭 액세스 차단 해제
resource "aws_s3_bucket_public_access_block" "frontend" {
  bucket = aws_s3_bucket.frontend.id

  block_public_acls       = false
  block_public_policy     = false
  ignore_public_acls      = false
  restrict_public_buckets = false
}

# SPA 라우팅 지원: 존재하지 않는 경로도 index.html 로 응답
resource "aws_s3_bucket_website_configuration" "frontend" {
  bucket = aws_s3_bucket.frontend.id

  index_document {
    suffix = "index.html"
  }

  error_document {
    key = "index.html"
  }
}

# 버킷 정책: 익명 사용자에게 객체 읽기(GetObject)만 허용
data "aws_iam_policy_document" "frontend_public_read" {
  statement {
    sid    = "PublicReadGetObject"
    effect = "Allow"

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.frontend.arn}/*"]
  }
}

resource "aws_s3_bucket_policy" "frontend" {
  bucket = aws_s3_bucket.frontend.id
  policy = data.aws_iam_policy_document.frontend_public_read.json

  # 퍼블릭 액세스 차단 해제가 먼저 적용되어야 정책을 붙일 수 있음
  depends_on = [aws_s3_bucket_public_access_block.frontend]
}

# 프론트엔드 SPA 업로드
resource "aws_s3_object" "index_html" {
  bucket       = aws_s3_bucket.frontend.id
  key          = "index.html"
  source       = "${path.module}/../frontend/index.html"
  content_type = "text/html; charset=utf-8"

  # 파일 내용이 바뀌면 다시 업로드되도록 해시 지정
  etag = filemd5("${path.module}/../frontend/index.html")
}

# 런타임 설정 파일(config.js)을 Terraform 이 직접 생성/업로드
# → 배포 후 프론트엔드 수정 없이 즉시 동작 (하드코딩 제거)
resource "aws_s3_object" "config_js" {
  bucket       = aws_s3_bucket.frontend.id
  key          = "config.js"
  content_type = "application/javascript; charset=utf-8"

  content = <<-EOT
    // 이 파일은 Terraform 이 자동 생성합니다. 직접 수정하지 마세요.
    window.APP_CONFIG = {
      region: "${var.aws_region}",
      userPoolId: "${aws_cognito_user_pool.this.id}",
      userPoolClientId: "${aws_cognito_user_pool_client.web.id}",
      apiBaseUrl: "${aws_apigatewayv2_api.this.api_endpoint}"
    };
  EOT
}
