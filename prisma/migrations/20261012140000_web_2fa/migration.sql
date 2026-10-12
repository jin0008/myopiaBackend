-- 웹(myopiamanage) 로그인 2단계 인증.
ALTER TABLE "user"
  ADD COLUMN "totp_secret" BYTEA,
  ADD COLUMN "totp_pending_secret" BYTEA,
  ADD COLUMN "totp_enabled_at" TIMESTAMPTZ(6),
  ADD COLUMN "totp_last_step" INTEGER,
  ADD COLUMN "totp_backup_hashes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- 웹 로그인 세션을 모두 끊는다. 이미 로그인해 있던 사람도 다음 접속부터
-- 2단계 인증을 거치게 한다(앱은 refresh token 을 써서 이 표와 무관하다).
DELETE FROM "session";
