# 가족 게임 시간 관리 (Family Game Time)

AWS 서버리스 아키텍처 기반 가족 그룹별 게임 시간 관리 웹사이트.
Free Tier 종료 이후에도 월 비용이 거의 0원에 수렴하도록 설계되었다.

## 아키텍처

```
CloudFront (HTTPS, 기본 도메인)
    ↓
Frontend (S3 Static Website, Vanilla JS SPA)
    ↓
API Gateway HTTP API (Cognito JWT Authorizer, CORS)
    ↓
AWS Lambda (Node.js 20.x, arm64, 단일 함수 라우팅)
    ↓
DynamoDB (PAY_PER_REQUEST, Query 전용 - Scan 미사용)
    +
Amazon Cognito (User Pool, 그룹 기반 권한: admin / Parents / Children + 가족 그룹)
```

- HTTPS 제공을 위해 CloudFront를 사용하되, 커스텀 도메인/Route53/ACM 없이 기본 도메인(`*.cloudfront.net`)만 사용해 상시 무료 티어(월 1TB 전송 + 1,000만 요청) 내에서 운영한다.
- EC2, RDS 등 고정 비용이 발생하는 서비스는 사용하지 않는다.
- 모든 사용자는 **역할 그룹**(admin/Parents/Children 중 하나)에 속하고,
  부모/자녀는 추가로 **가족 그룹**(그룹 이름 = 가족 ID)에 반드시 속한다.
  admin 은 가족 그룹 없이도 인증/관리가 가능하다 (가족 없는 관리 전용 계정 허용).
  모든 데이터 접근은 JWT 의 가족 그룹으로 격리된다.
- 게임 시간 변경은 DynamoDB 트랜잭션으로 잔여 시간 갱신 + 이력 기록의 원자성을 보장한다.

## 권한 모델

| 역할 | 권한 |
|---|---|
| admin | 모든 권한. 가족 그룹 생성/삭제, 모든 가족의 사용자 추가/삭제/역할 변경/활성화/비밀번호 초기화. **생성은 `scripts/create-admin.sh`, 삭제는 `scripts/delete-user.sh` 로만 가능** (웹/API 로 생성·삭제·역할 변경 불가). |
| Parents (부모) | 본인 가족의 사용자(부모/자녀) 추가/삭제 (본인 삭제 포함). 자녀 게임 시간 추가/차감. |
| Children (자녀) | 게임 시간 조회만 가능. |

- 가족 그룹에서 부모가 모두 삭제되면 남은 자녀 계정과 가족 그룹도 자동 삭제된다.
  (단, admin 이 속한 가족 그룹은 자동 정리 대상에서 제외된다.)
- 사용자가 남아있는 가족 그룹은 `DELETE /groups` 로 삭제할 수 없다.

## 디렉터리 구조

```
terraform/   Terraform 인프라 정의 (Cognito, DynamoDB, Lambda, API GW, S3, IAM, CloudWatch)
backend/     Lambda 소스 (Node.js 20, ES Module - AWS SDK v3 는 런타임 내장이라 npm install 불필요)
frontend/    SPA (index.html 단일 파일, FullCalendar CDN)
scripts/     운영 스크립트 (create-admin.sh, delete-user.sh)
```

## 배포 방법

### 1. 인프라 배포

```bash
cd terraform
terraform init
terraform apply
```

배포가 끝나면 다음 출력값을 확인할 수 있다.

- `frontend_url` : 웹사이트 접속 URL (HTTPS, CloudFront)
- `s3_website_url` : S3 직접 접근 URL (HTTP, 디버깅 전용)
- `api_gateway_url` : API 엔드포인트
- `cognito_user_pool_id` : User Pool ID
- `cognito_client_id` : User Pool Client ID

프론트엔드 설정 파일(`config.js`)은 Terraform 이 자동 생성하여 S3 에 업로드하므로
별도의 수동 수정이 필요 없다.

### 2. 최초 admin 계정 생성

admin 계정은 이 스크립트로만 생성할 수 있다. (웹/API 로 생성 불가,
비밀번호가 Terraform state 에 남지 않도록 AWS CLI 로 처리)
`-f` 지정 시 가족 그룹(이름=family_id)이 없으면 자동으로 생성한 뒤 admin 을
`admin` 그룹과 가족 그룹 양쪽에 추가한다. `-f` 를 생략하면 가족 없는
관리 전용 계정이 된다 (게임 시간 대시보드는 비어 있음).

```bash
cd scripts
./create-admin.sh -u admin -f kim-family -n "관리자"
./create-admin.sh -u superadmin -n "전체 관리자"   # 가족 없는 관리 전용 계정
```

출력된 임시 비밀번호로 웹사이트에서 최초 로그인하면
새 비밀번호 설정 화면(NEW_PASSWORD_REQUIRED)이 표시된다.

admin 계정 삭제 역시 스크립트로만 가능하다.

```bash
./delete-user.sh -u admin
```

> Windows 에서는 Git Bash 또는 WSL 에서 실행한다.

### 3. 가족 그룹 / 사용자 추가

admin 으로 로그인 → 관리 탭:

1. **가족 그룹 관리**에서 새 가족 그룹(가족 ID)을 생성한다.
2. **사용자 생성**에서 해당 가족에 부모(Parents) / 자녀(Children) 계정을 만든다.
   생성 시 표시되는 임시 비밀번호를 해당 가족 구성원에게 전달하면 된다.

부모는 본인의 관리 탭에서 자기 가족의 사용자를 직접 추가/삭제할 수 있다.

## API 요약

| 메서드 | 경로 | 권한 | 설명 |
|---|---|---|---|
| GET | /game-time | 전체 | 가족의 자녀별 남은 게임 시간 조회 |
| POST | /game-time | admin, Parents | 게임 시간 추가(SAVE)/차감(USE) |
| GET | /game-time/events | 전체 | 게임 시간 변경 이력 조회 (달력) |
| GET | /users | admin, Parents | 사용자 목록 (admin: `?family_id=all` 전체 / 부모: 본인 가족만) |
| POST | /users | admin, Parents | 사용자 생성 (부모는 본인 가족에만, admin 역할 부여 불가) |
| DELETE | /users | admin, Parents | 사용자 삭제 (부모는 본인 가족만·본인 포함, admin 계정 삭제 불가) |
| PATCH | /users/group | admin | 역할(Parents/Children) 변경 (admin 역할은 변경 불가) |
| PATCH | /users/status | admin | 활성/비활성 변경 |
| POST | /reset-password | admin | 비밀번호 초기화 (임시 비밀번호 재발급) |
| POST | /groups | admin | 가족 그룹 생성 |
| DELETE | /groups | admin | 가족 그룹 삭제 (빈 그룹만 가능) |

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
