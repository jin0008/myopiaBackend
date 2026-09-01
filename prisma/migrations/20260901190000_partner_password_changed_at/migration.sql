-- 파트너 토큰은 14일짜리 JWT 라 폐기 목록이 없다. 비밀번호를 바꾼 시각을
-- 남겨, 그보다 먼저 발급된 토큰을 거절한다.
ALTER TABLE "hospital_account" ADD COLUMN "password_changed_at" TIMESTAMPTZ(6);
