-- Polls compete with posts in the 인기글 ranking, so they need the same signal.
ALTER TABLE "poll" ADD COLUMN "view_count" INTEGER NOT NULL DEFAULT 0;
