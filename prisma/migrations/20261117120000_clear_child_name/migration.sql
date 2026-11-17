-- 자녀 실명을 더 받지 않는다.
--
-- 앱은 호칭(nickname)만 쓰고, 병원 화면도 이미 호칭을 보여준다. 쓰지 않는
-- 아동 실명을 들고 있을 이유가 없으니 저장된 값은 지운다. 컬럼은 남겨 둔다
-- (지우는 건 되돌릴 수 없고, 옛 앱이 보내는 name 은 서버가 버린다).
UPDATE "parent_child_link" SET "name" = NULL WHERE "name" IS NOT NULL;
