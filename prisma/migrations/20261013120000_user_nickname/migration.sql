-- 앱 표시 이름을 로그인 아이디에서 떼어 낸다. 로그인은 이메일로 하고, 이 이름으로 활동한다.
ALTER TABLE "user" ADD COLUMN "nickname" VARCHAR;

-- 아이디로 가입한 계정은 지금까지 보이던 이름(아이디)을 그대로 닉네임으로 쓴다.
-- 아이디는 이미 겹치지 않으므로 여기서는 충돌이 없다.
UPDATE "user" u SET "nickname" = p."username"
FROM "password_auth" p
WHERE p."user_id" = u."id";

-- 소셜로만 가입해 아이디가 없는 계정은 이메일 앞부분(test@gmail.com → test).
-- 이미 쓰는 이름이면 뒤에 숫자를 붙인다(test2, test3 …). 이메일도 없으면 '회원'.
DO $$
DECLARE
  r RECORD;
  base TEXT;
  cand TEXT;
  n INT;
BEGIN
  FOR r IN SELECT "id", "email" FROM "user" WHERE "nickname" IS NULL ORDER BY "created_at" LOOP
    base := COALESCE(NULLIF(split_part(r."email", '@', 1), ''), '회원');
    cand := base;
    n := 1;
    WHILE EXISTS (SELECT 1 FROM "user" WHERE "nickname" = cand) LOOP
      n := n + 1;
      cand := base || n;
    END LOOP;
    UPDATE "user" SET "nickname" = cand WHERE "id" = r."id";
  END LOOP;
END $$;

CREATE UNIQUE INDEX "user_nickname_key" ON "user"("nickname");
