-- 앱 보호자 정지. 비어 있으면 정상이다.
-- 지우지 않고 막는다 - 커뮤니티에서 문제를 일으킨 사람을 내보내되, 기록과
-- 신고 이력은 남겨 판단 근거로 쓴다. 풀면 그대로 다시 쓸 수 있다.
ALTER TABLE "user"
  ADD COLUMN "suspended_at" TIMESTAMPTZ(6),
  ADD COLUMN "suspended_reason" TEXT;
