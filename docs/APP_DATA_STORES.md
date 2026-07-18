# 앱 전용 데이터 스토어 설계 (App Data Stores)

마이오닥(MyoDoc) 앱의 **비임상(app-only) 데이터** — 커뮤니티 게시판, AI 챗봇
사용량 카운터·대화 로그, 푸시 토큰 — 를 어디에 어떻게 둘지에 대한 설계.

핵심 원칙(이전 논의와 동일):

1. **임상 데이터는 공유 PostgreSQL 유지.** 앱은 `patient / measurement / refractive_error …`
   를 **읽기 전용**으로만 접근한다(FK로 강하게 결합돼 있어 분리 시 무결성이 깨짐).
2. **앱 전용 데이터는 "물리적 분리"가 아니라 "논리적 격리"로 시작.** 같은 인스턴스 안에서
   전용 스키마(`app`) + 최소권한 role + Redis로 나눈다. 조기 물리분리는 비용만 크다.
3. **나중에 물리 분리로 갈 수 있는 경로를 열어둔다**(§8).

---

## 1. 목표 토폴로지

```
┌──────────────────────────── PostgreSQL (1 instance) ────────────────────────────┐
│                                                                                  │
│  schema: public  (웹/임상 — 웹 role 소유)          schema: app (앱 전용)          │
│  ┌───────────────────────────────┐                ┌─────────────────────────────┐│
│  │ user (공유 인증)              │◀── user_id FK ─│ community_post/comment/like  ││
│  │ patient, measurement,         │                │ chat_log, chat_feedback      ││
│  │ refractive_error, hospital …  │◀─ read only ───│ device_token                 ││
│  │ parent_child_link,            │  (mobile role) │                             ││
│  │ child_hospital_link …         │                └─────────────────────────────┘│
│  └───────────────────────────────┘                                               │
└──────────────────────────────────────────────────────────────────────────────────┘
        ▲                                                   ▲
        │ DATABASE_URL (web role: full)                     │ DATABASE_URL_MOBILE
        │                                                   │ (mobile_app role: 최소권한)
   web server                                          mobile API (/api/mobile/*)
                                                            │
                          ┌─────────────────────────────────┼───────────────────────┐
                          ▼                                  ▼                       ▼
                    Redis (신규)                     GCS 버킷 (선택)          FCM (신규)
             chat 사용량 카운터 / 레이트리밋      chat_log 장기 아카이브        푸시 발송
                                                  → BigQuery 분석
```

- **한 개의 Postgres, 두 개의 스키마.** `public`(웹·임상)과 `app`(앱 전용)을 나누고,
  모바일 서버는 **최소권한 role**로 접속한다.
- **Redis**: 챗봇 카운터처럼 뜨겁고(고빈도 write) 휘발성인 데이터.
- **GCS(선택)**: 대화 로그 장기 보관 + BigQuery 분석.
- **FCM**: 푸시 발송(안드로이드 네이티브, iOS는 APNs를 FCM으로 래핑).

> Prisma는 6.x에서 multi-schema가 GA다. `datasource`에 `schemas = ["public","app"]`,
> 앱 모델에 `@@schema("app")`를 붙이면 된다.

---

## 2. 격리의 핵심 — 최소권한 role (DB를 안 쪼개고 얻는 보안 격리)

모바일 서버가 임상 테이블을 **읽기만** 하고, 앱 테이블만 **쓰도록** DB 레벨에서 강제한다.
"앱 DB를 분리해서 얻고 싶던 보안 이점"의 대부분을 여기서 얻는다.

```sql
-- 1) 앱 전용 스키마
CREATE SCHEMA IF NOT EXISTS app;

-- 2) 모바일 서버 전용 role
CREATE ROLE mobile_app LOGIN PASSWORD '<strong-secret>';

-- 3) 임상/공유 데이터: 읽기 전용만
GRANT USAGE ON SCHEMA public TO mobile_app;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO mobile_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO mobile_app;

-- 3-1) 단, 앱이 소유하는 몇몇 public 테이블은 쓰기 허용
--      (parent_child_link / child_hospital_link / mobile_refresh_token / oauth_identity)
GRANT INSERT, UPDATE, DELETE ON
  parent_child_link, child_hospital_link, mobile_refresh_token, oauth_identity
  TO mobile_app;

-- 4) 앱 스키마: 읽기·쓰기 전부
GRANT USAGE, CREATE ON SCHEMA app TO mobile_app;
GRANT ALL ON ALL TABLES IN SCHEMA app TO mobile_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA app GRANT ALL ON TABLES TO mobile_app;
GRANT ALL ON ALL SEQUENCES IN SCHEMA app TO mobile_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA app GRANT ALL ON SEQUENCES TO mobile_app;
```

- 웹 서버는 기존 role(`DATABASE_URL`) 그대로.
- 모바일 서버는 `DATABASE_URL_MOBILE`(= `mobile_app` 계정)로 접속.
- 이러면 모바일 API에 취약점이 생겨도 **임상 데이터는 수정·삭제가 불가**(DB가 거부).

> 마이그레이션은 여전히 소유자(웹 role/관리자)가 `prisma migrate deploy`로 실행한다.
> 앱 런타임 계정과 스키마 변경 계정을 분리하는 것이 안전하다.

---

## 3. 커뮤니티 게시판

**현재:** `public` 스키마에 `community_post / community_comment / community_post_like /
community_comment_like` 존재(마이그레이션 `20260515080000_community_board`). `user` FK(CASCADE).

**설계:** 구조는 그대로 두고 **`app` 스키마로 이동**만 한다(선택이지만 권장 — 경계가 명확해짐).

```sql
ALTER TABLE public.community_post          SET SCHEMA app;
ALTER TABLE public.community_comment       SET SCHEMA app;
ALTER TABLE public.community_post_like     SET SCHEMA app;
ALTER TABLE public.community_comment_like  SET SCHEMA app;
```

- `user` FK는 유지한다. `user`는 웹/앱이 함께 쓰는 **공유 인증 테이블**이라 앱 소유가 아니다.
  (cross-schema FK는 같은 DB 안이라 문제없다.)
- 코드 변경은 Prisma 모델에 `@@schema("app")`만 추가.
- **완전 물리분리를 원하면** §8 참조 — `user` FK를 끊고 앱이 `app.user_profile`을 소유한다.

---

## 4. AI 챗봇 — 카운터 / 로그 / 피드백

현재 전부 **서버 로컬 파일**(`CHAT_DATA_DIR`의 `usage-*.json`, `chat-*.jsonl`). 단일 서버·저트래픽엔
문제없지만, 재배포 시 소실 + 다중 인스턴스에서 카운터 불일치. 데이터 특성에 맞춰 셋으로 나눈다.

### 4-1. 사용량 카운터 → Redis

고빈도 증가 + 원자성 + 일 단위 자동만료 → Redis가 정답. 파일 대체.

```
키:   chat:usage:user:{userId}:{yyyymmdd}   (INCR, EXPIRE 36h)
      chat:usage:total:{yyyymmdd}           (INCR, EXPIRE 36h)
로직: 요청마다 INCR → 한도 초과면 "limited" 응답. TTL로 자정 지나면 자동 리셋.
```

원자적 한도 체크(경합 방지)는 Lua 한 방으로:

```lua
-- KEYS[1]=user키 KEYS[2]=total키 ARGV[1]=userLimit ARGV[2]=totalLimit ARGV[3]=ttl
local u = redis.call('INCR', KEYS[1]); redis.call('EXPIRE', KEYS[1], ARGV[3])
local t = redis.call('INCR', KEYS[2]); redis.call('EXPIRE', KEYS[2], ARGV[3])
if t > tonumber(ARGV[2]) then return 'total_limit' end
if u > tonumber(ARGV[1]) then return 'ip_limit' end
return 'ok'
```

- Redis 없으면(개발) 기존 파일 방식으로 폴백하도록 어댑터 인터페이스를 둔다.
- 레이트리밋(`/auth/*` 등)도 같은 Redis로 확장 가능.

### 4-2. 대화 로그 → `app.chat_log` 테이블

품질 개선 루프(미답·부정확 질문을 감수 Q&A로 반영)를 위해 **조회 가능한** 저장이 필요 → DB 테이블.

```sql
CREATE TABLE app.chat_log (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID REFERENCES public."user"(id) ON DELETE SET NULL,  -- 탈퇴해도 로그는 익명 보존
  ts           TIMESTAMPTZ NOT NULL DEFAULT now(),
  mode         TEXT NOT NULL,                 -- qa|general|consult|emergency|limited|error
  question     TEXT NOT NULL,
  answer       TEXT,
  refs         TEXT[] NOT NULL DEFAULT '{}',
  rag_ids      TEXT[] NOT NULL DEFAULT '{}',  -- 검색된 문항 id + 점수
  search_used  BOOLEAN NOT NULL DEFAULT false,
  tok_in       INTEGER NOT NULL DEFAULT 0,
  tok_out      INTEGER NOT NULL DEFAULT 0,
  latency_ms   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_chat_log_ts   ON app.chat_log (ts DESC);
CREATE INDEX idx_chat_log_mode ON app.chat_log (mode);
```

- **PII 최소화**: `question`/`answer`에 개인정보가 섞일 수 있으므로 (a) 실서비스에선 보존기간
  정책(예: 90일 후 삭제/익명화)과 (b) `user_id`는 `ON DELETE SET NULL`로 탈퇴 시 익명화.
- **장기 아카이브(선택)**: nightly 배치로 오래된 로그를 GCS(JSONL)로 내보내고 DB에선 삭제 →
  BigQuery로 분석. Google Cloud라 자연스러운 경로.

### 4-3. 피드백(도움됨/안됨) → `app.chat_feedback`

```sql
CREATE TABLE app.chat_feedback (
  id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id   UUID REFERENCES public."user"(id) ON DELETE SET NULL,
  ts        TIMESTAMPTZ NOT NULL DEFAULT now(),
  helpful   BOOLEAN NOT NULL,
  question  TEXT,
  answer    TEXT
);
```

챗봇 엔드포인트의 `type:"feedback"` 분기가 파일 대신 이 테이블에 기록.

---

## 5. 푸시 토큰 (신규)

현재 없음. 임상 데이터와 무관하므로 `app` 스키마에 단순 테이블 하나.

```sql
CREATE TABLE app.device_token (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES public."user"(id) ON DELETE CASCADE,
  token       TEXT NOT NULL UNIQUE,          -- FCM 등록 토큰
  platform    TEXT NOT NULL,                 -- 'ios' | 'android'
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at  TIMESTAMPTZ
);
CREATE INDEX idx_device_token_user ON app.device_token (user_id);
```

**엔드포인트**

```
POST   /api/mobile/notifications/device-token   (auth)  { token, platform } → upsert (token unique)
DELETE /api/mobile/notifications/device-token   (auth)  { token }           → 로그아웃/해지 시 revoke
```

**발송 경로**: FCM 통합 사용(iOS는 APNs 키를 FCM에 등록). 새 측정값 도착·진료 임박 알림은
**웹에서 측정값이 저장되는 지점**이나 별도 워커에서 트리거 → 해당 자녀의 보호자 device_token 조회 → FCM 발송.
발송 실패(`NotRegistered`) 토큰은 `revoked_at` 처리.

**환경변수**: `FCM_PROJECT_ID`, `FCM_SERVICE_ACCOUNT_JSON`(또는 ADC), (iOS) APNs 키는 FCM 콘솔 등록.

---

## 6. 환경변수 요약

```
# 접속 (역할 분리)
DATABASE_URL=postgres://web_role:…@host/db            # 웹(기존)
DATABASE_URL_MOBILE=postgres://mobile_app:…@host/db   # 모바일 API 런타임(최소권한)

# 챗봇
REDIS_URL=redis://…                 # 카운터/레이트리밋 (없으면 파일 폴백)
CHAT_LOG_SINK=db                    # db | gcs | file(개발)
GCS_CHAT_ARCHIVE_BUCKET=…           # (선택) 로그 아카이브
GEMINI_API_KEY=…                    # (기존) RAG

# 푸시
FCM_PROJECT_ID=…
FCM_SERVICE_ACCOUNT_JSON=…          # 또는 GCE 기본 서비스계정(ADC)
```

---

## 7. 단계별 롤아웃 (작은 단위로, 무중단)

| 단계 | 내용 | 리스크 |
|------|------|--------|
| **1** | `app` 스키마 생성 + `mobile_app` role/권한 + `DATABASE_URL_MOBILE` 전환 | 낮음(권한만) |
| **2** | 커뮤니티 4테이블 `app` 스키마로 이동 + Prisma `@@schema` | 낮음(rename) |
| **3** | `app.device_token` + device-token 엔드포인트 (푸시 발송은 다음) | 낮음(신규) |
| **4** | 챗봇 카운터 Redis 전환(어댑터, 파일 폴백 유지) | 중간 |
| **5** | 챗봇 로그·피드백 `app.chat_log/chat_feedback` 전환 → 파일 폐기 | 중간 |
| **6** | (선택) 로그 GCS 아카이브 + BigQuery, 보존기간 배치 | 중간 |
| **7** | 푸시 발송 파이프라인(FCM) + 트리거 | 중간 |
| **8** | (필요 시) `app` 스키마를 별도 인스턴스로 물리 분리 (§8) | 높음 |

각 단계는 독립적으로 배포·롤백 가능하다. 지금 당장은 **1~3만 해도** "앱 데이터 격리 + 보안"의
실질 이득을 얻고, 4~5로 챗봇 저장을 프로덕션급으로 올린다.

---

## 8. 물리적 분리로 가는 경로 (미래, 필요할 때만)

`app` 스키마를 **별도 DB 인스턴스**로 떼려면 유일한 결합점은 **공유 `user` 테이블**(community/chat/
device_token이 `user_id` FK로 참조)이다. 처리 방법:

1. 앱이 자체 `app.user_profile(user_id PK, display_name, …)`를 소유하고, 로그인 시 auth의
   user id로 upsert한다. 이후 앱 테이블은 `user`가 아니라 `app.user_profile`을 참조(같은 값).
2. cross-schema/cross-DB FK를 제거(값 기반 참조로 전환). 임상 테이블과의 FK는 원래 없으므로
   community/chat/device_token은 **어떤 임상 무결성도 잃지 않고** 이동 가능.
3. 그 시점에 `app` 스키마를 pg_dump로 새 인스턴스에 옮기고 `DATABASE_URL_MOBILE`만 교체.

즉 지금 §2~§5 설계를 그대로 따르면, 물리 분리는 **나중에 스위치 하나**로 열리는 옵션이 된다.
반대로 지금 미리 물리 분리하면 §1의 임상 결합·동기화 문제를 떠안게 되므로 권장하지 않는다.

---

### 요약

- 임상 데이터: 공유 Postgres, 앱은 읽기 전용(그대로).
- 앱 데이터: 같은 Postgres의 **`app` 스키마 + 최소권한 role**로 논리 격리.
- 챗봇 카운터: **Redis**, 로그/피드백: **`app.chat_log` / `app.chat_feedback`**(파일 폐기).
- 푸시 토큰: **`app.device_token`** + FCM.
- 물리적 별도 DB는 지금 불필요 — 위 설계가 그 경로를 미리 열어둔다.
