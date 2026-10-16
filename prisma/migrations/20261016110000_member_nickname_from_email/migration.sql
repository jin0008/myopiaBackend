-- '회원12' 같은 닉네임을 이메일 앞부분으로 바꾼다.
--
-- 20261013120000_user_nickname 은 이메일이 없던 소셜 계정(카카오 비즈 승인 전 가입)에 '회원'+숫자를
-- 붙였다. 그 뒤 다시 로그인하면서 이메일은 채워졌지만 닉네임은 그대로 남았다. 아직 사람이 닉네임을
-- 확인하지 않은(profile_confirmed_at 이 빈) 계정만 바꾼다 - 스스로 '회원12' 를 고른 사람은 건드리지 않는다.
-- 애플 '이메일 가리기' 주소는 앞부분이 무작위 글자라 이름으로 쓸 수 없어 제외한다.
-- 겹치면 뒤에 숫자를 붙인다(test, test2 …) - 처음 마이그레이션과 같은 규칙.
DO $$
DECLARE
  r RECORD;
  base TEXT;
  cand TEXT;
  n INT;
BEGIN
  FOR r IN
    SELECT "id", "email" FROM "user"
    WHERE "nickname" ~ '^회원[0-9]*$'
      AND "profile_confirmed_at" IS NULL
      AND "email" IS NOT NULL
      AND "email" NOT LIKE '%@privaterelay.appleid.com'
    ORDER BY "created_at"
  LOOP
    base := NULLIF(split_part(r."email", '@', 1), '');
    CONTINUE WHEN base IS NULL;
    cand := base;
    n := 1;
    WHILE EXISTS (SELECT 1 FROM "user" WHERE "nickname" = cand AND "id" <> r."id") LOOP
      n := n + 1;
      cand := base || n;
    END LOOP;
    UPDATE "user" SET "nickname" = cand WHERE "id" = r."id";
  END LOOP;
END $$;
