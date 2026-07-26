# ==============================================================================
# Terraform 및 Provider 버전 정의
# ==============================================================================

terraform {
  # Terraform 최소 버전 요구사항
  # (S3 backend 네이티브 잠금(use_lockfile)을 위해 1.10 이상 필요)
  required_version = ">= 1.10.0"

  backend "s3" {
    bucket       = "dmk-gametime-tfstate"
    key          = "game-time/terraform.tfstate"
    region       = "ap-northeast-2"
    encrypt      = true
    use_lockfile = true
  }

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
