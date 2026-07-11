# 가족 게임 시간 관리 (Family Game Time)

AWS 서버리스 아키텍처 기반 가족 그룹별 게임 시간 관리 웹사이트.
Free Tier 종료 이후에도 월 비용이 거의 0원에 수렴하도록 설계되었다.

## 아키텍처

```
Frontend (S3 Static Website, Vanilla JS SPA)
    ↓
API Gateway HTTP API (Cognito JWT Authorizer, CORS)
    ↓
AWS Lambda (Node.js 20.x, arm64, 단일 함수 라우팅)
    ↓
DynamoDB (PAY_PER_REQUEST, Query 전용 - Scan 미사용)
    +
Amazon Cognito (User Pool, 그룹 기반 권한: admin / Parents / Children)
```

- CloudFront, Route53, EC2, RDS 등 고정 비용이 발생하는 서비스는 사용하지 않는다.
- 모든 데이터 접근은 JWT Claim 의 `custom:family_id` 로 격리된다.
- 게임 시간 변경은 DynamoDB 트랜잭션으로 잔여 시간 갱신 + 이력 기록의 원자성을 보장한다.

## 디렉터리 구조

```
terraform/   Terraform 인프라 정의 (Cognito, DynamoDB, Lambda, API GW, S3, IAM, CloudWatch)
backend/     Lambda 소스 (Node.js 20, ES Module - AWS SDK v3 는 런타임 내장이라 npm install 불필요)
frontend/    SPA (index.html 단일 파일, FullCalendar CDN)
scripts/     운영 스크립트 (create-admin.sh)
```

## 배포 방법

### 1. 인프라 배포

```bash
cd terraform
terraform init
terraform apply
```

배포가 끝나면 다음 출력값을 확인할 수 있다.

- `s3_website_url` : 웹사이트 접속 URL
- `api_gateway_url` : API 엔드포인트
- `cognito_user_pool_id` : User Pool ID
- `cognito_client_id` : User Pool Client ID

프론트엔드 설정 파일(`config.js`)은 Terraform 이 자동 생성하여 S3 에 업로드하므로
별도의 수동 수정이 필요 없다.

### 2. 최초 admin 계정 생성

admin 비밀번호가 Terraform state 에 남지 않도록 AWS CLI 스크립트로 생성한다.

```bash
cd scripts
./create-admin.sh -u admin -f kim-family -n "관리자"
```

출력된 임시 비밀번호로 웹사이트에서 최초 로그인하면
새 비밀번호 설정 화면(NEW_PASSWORD_REQUIRED)이 표시된다.

> Windows 에서는 Git Bash 또는 WSL 에서 실행한다.

### 3. 사용자 추가

admin 으로 로그인 → 관리자 탭 → 사용자 생성에서
부모(Parents) / 자녀(Children) 계정을 웹 화면에서 생성한다.
생성 시 표시되는 임시 비밀번호를 해당 가족 구성원에게 전달하면 된다.

## API 요약

| 메서드 | 경로 | 권한 | 설명 |
|---|---|---|---|
| GET | /game-time | 전체 | 가족의 자녀별 남은 게임 시간 조회 |
| POST | /game-time | admin, Parents | 게임 시간 추가(SAVE)/차감(USE) |
| GET | /game-time/events | 전체 | 게임 시간 변경 이력 조회 (달력) |
| GET | /users | admin | 사용자 목록 (기본: 내 가족, `?family_id=all` 전체) |
| POST | /users | admin | 사용자 생성 (임시 비밀번호 발급) |
| PATCH | /users/group | admin | 권한(그룹) 변경 |
| PATCH | /users/status | admin | 활성/비활성 변경 |
| POST | /reset-password | admin | 비밀번호 초기화 (임시 비밀번호 재발급) |

## 데이터 모델

**FamilyGameTime** (현재 잔여 시간)

- PK `family_id`, SK `child_name`
- 속성: `remaining_minutes`, `updated_at`

**FamilyGameTimeEvents** (변경 이력)

- PK `family_id`, SK `sk` = `EVENT#<ISO타임스탬프>#<UUID>`
- 속성: `id`, `child_name`, `action_type`(SAVE/USE), `minutes`, `description`,
  `target_date`, `created_by`, `created_at`

## 정리(삭제)

```bash
cd terraform
terraform destroy
```
