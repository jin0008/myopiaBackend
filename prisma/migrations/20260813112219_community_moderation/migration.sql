-- UGC moderation: content reports + user blocks (App Store guideline 1.2)
CREATE TABLE "content_report" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "reporter_user_id" UUID NOT NULL,
  "target_type" TEXT NOT NULL,
  "target_id" TEXT NOT NULL,
  "target_user_id" UUID,
  "reason" TEXT NOT NULL,
  "detail" TEXT,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "content_report_pk" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "content_report_once_unique"
  ON "content_report" ("reporter_user_id", "target_type", "target_id");
CREATE INDEX "idx_content_report_status"
  ON "content_report" ("status", "created_at" DESC);

CREATE TABLE "user_block" (
  "blocker_user_id" UUID NOT NULL,
  "blocked_user_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "user_block_pk" PRIMARY KEY ("blocker_user_id", "blocked_user_id")
);
CREATE INDEX "idx_user_block_blocker" ON "user_block" ("blocker_user_id");
