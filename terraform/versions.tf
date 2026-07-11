# ==============================================================================
# Terraform 및 Provider 버전 정의
# ==============================================================================

terraform {
  # Terraform 최소 버전 요구사항
  required_version = ">= 1.6.0"

  required_providers {
    # AWS Provider - 모든 AWS 리소스 생성에 사용
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }

    # Archive Provider - Lambda 배포용 ZIP 파일 생성에 사용
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.4"
    }
  }
}
