-- 이메일 인증 코드 보관함.
CREATE TABLE "email_verification" (
  "id"          UUID         NOT NULL DEFAULT gen_random_uuid(),
  "email"       TEXT         NOT NULL,
  "code_hash"   TEXT         NOT NULL,
  "purpose"     TEXT         NOT NULL,
  "attempts"    INTEGER      NOT NULL DEFAULT 0,
  "expires_at"  TIMESTAMPTZ(6) NOT NULL,
  "consumed_at" TIMESTAMPTZ(6),
  "created_at"  TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "email_verification_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "email_verification_email_purpose_idx" ON "email_verification"("email", "purpose");
CREATE INDEX "email_verification_expires_at_idx" ON "email_verification"("expires_at");

-- 계정 하나에 주소 하나.
--
-- 중복이 이미 있으면 이 문장이 실패한다. 그 편이 낫다 - 조용히 넘어가면
-- 어느 계정으로 비밀번호 재설정 메일을 보낼지 정할 수 없는 상태가 남는다.
-- 실패하면 아래로 중복을 찾아 정리한 뒤 다시 배포한다.
--   SELECT email, count(*) FROM "user" WHERE email IS NOT NULL
--   GROUP BY email HAVING count(*) > 1;
CREATE UNIQUE INDEX "user_email_key" ON "user"("email");
