# ==============================================================================
# 입력 변수 정의
# ==============================================================================

variable "aws_region" {
  description = "리소스를 배포할 AWS 리전"
  type        = string
  default     = "ap-northeast-2"
}

variable "project_name" {
  description = "프로젝트 이름 (리소스 이름 접두사로 사용, 소문자/숫자/하이픈만 허용)"
  type        = string
  default     = "family-game-time"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{2,30}$", var.project_name))
    error_message = "project_name 은 소문자로 시작하고, 소문자/숫자/하이픈으로 3~31자 이내여야 합니다."
  }
}

variable "log_retention_days" {
  description = "CloudWatch Logs 보존 기간 (일)"
  type        = number
  default     = 7

  validation {
    condition     = contains([1, 3, 5, 7, 14, 30], var.log_retention_days)
    error_message = "log_retention_days 는 1, 3, 5, 7, 14, 30 중 하나여야 합니다."
  }
}

variable "lambda_memory_size" {
  description = "Lambda 함수 메모리 크기 (MB) - 비용 최소화를 위해 128MB 기본값 사용"
  type        = number
  default     = 128
}

variable "lambda_timeout" {
  description = "Lambda 함수 타임아웃 (초)"
  type        = number
  default     = 10
}
