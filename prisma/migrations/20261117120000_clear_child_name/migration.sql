-- 자녀 실명을 더 받지 않는다.
--
-- 앱은 호칭(nickname)만 쓰고, 병원 화면도 이미 호칭을 보여준다. 쓰지 않는
-- 아동 실명을 들고 있을 이유가 없으니 저장된 값은 지운다.
-- 이 UPDATE 는 되돌릴 수 없다. 값이 필요할 수 있으면 배포 전에 따로 백업한다.
-- 컬럼은 남긴다 - 옛 앱이 보내는 name 은 서버가 버리므로 스키마를 바꿀 이유가 없다.
UPDATE "parent_child_link" SET "name" = NULL WHERE "name" IS NOT NULL;
