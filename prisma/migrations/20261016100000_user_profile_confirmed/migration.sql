-- 앱에서 닉네임·이메일을 직접 확인했는지. 소셜 첫 가입은 서버가 닉네임을 지어 줘 비어 있고,
-- 앱이 확인 창을 띄운다.
ALTER TABLE "user" ADD COLUMN "profile_confirmed_at" TIMESTAMPTZ(6);

-- 이메일·비밀번호로 가입한 계정은 가입 화면에서 닉네임과 이메일(인증)을 이미 정했다.
-- 소셜로만 가입한 계정은 비워 두어 다음 실행 때 한 번 확인하게 한다.
UPDATE "user" u SET "profile_confirmed_at" = now()
FROM "password_auth" p
WHERE p."user_id" = u."id";
