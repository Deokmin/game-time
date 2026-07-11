# ==============================================================================
# 출력 값 정의
# ==============================================================================

output "s3_website_url" {
  description = "프론트엔드 S3 정적 웹사이트 URL (브라우저에서 접속)"
  value       = "http://${aws_s3_bucket_website_configuration.frontend.website_endpoint}"
}

output "api_gateway_url" {
  description = "API Gateway HTTP API 엔드포인트 URL"
  value       = aws_apigatewayv2_api.this.api_endpoint
}

output "cognito_user_pool_id" {
  description = "Cognito User Pool ID (scripts/create-admin.sh 에서 사용)"
  value       = aws_cognito_user_pool.this.id
}

output "cognito_client_id" {
  description = "Cognito User Pool Client ID"
  value       = aws_cognito_user_pool_client.web.id
}
