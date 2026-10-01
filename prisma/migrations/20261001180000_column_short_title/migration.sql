-- 목록 카드용 짧은 제목. 목록과 본문이 바라는 제목이 다르다 - 본문에서
-- 친절한 긴 제목이 카드 두 줄에서는 기호만 빽빽해 무슨 글인지 안 읽힌다.
ALTER TABLE "expert_column" ADD COLUMN "short_title" TEXT;
