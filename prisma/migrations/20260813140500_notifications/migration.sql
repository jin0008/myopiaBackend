-- In-app notifications for community activity.
CREATE TABLE "notification" (
  "id"            UUID NOT NULL DEFAULT gen_random_uuid(),
  "user_id"       UUID NOT NULL,
  "actor_user_id" UUID,
  "type"          TEXT NOT NULL,
  "target_type"   TEXT NOT NULL,
  "target_id"     TEXT NOT NULL,
  "title"         TEXT,
  "preview"       TEXT,
  "read_at"       TIMESTAMPTZ(6),
  "created_at"    TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "notification_pk" PRIMARY KEY ("id")
);
CREATE INDEX "idx_notification_user" ON "notification" ("user_id", "created_at" DESC);
CREATE INDEX "idx_notification_unread" ON "notification" ("user_id", "read_at");
