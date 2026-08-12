-- Community polls (똑닥-style 설문)
CREATE TABLE "poll" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "user_id" UUID NOT NULL,
  "question" TEXT NOT NULL,
  "closes_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "deleted_at" TIMESTAMPTZ(6),
  CONSTRAINT "poll_pk" PRIMARY KEY ("id")
);
CREATE INDEX "idx_poll_created_at" ON "poll" ("created_at" DESC);

CREATE TABLE "poll_option" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "poll_id" UUID NOT NULL,
  "label" TEXT NOT NULL,
  "position" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "poll_option_pk" PRIMARY KEY ("id"),
  CONSTRAINT "poll_option_poll_fk" FOREIGN KEY ("poll_id") REFERENCES "poll" ("id") ON DELETE CASCADE
);
CREATE INDEX "idx_poll_option_poll" ON "poll_option" ("poll_id");

CREATE TABLE "poll_vote" (
  "user_id" UUID NOT NULL,
  "poll_id" UUID NOT NULL,
  "option_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "poll_vote_pk" PRIMARY KEY ("user_id", "poll_id"),
  CONSTRAINT "poll_vote_poll_fk" FOREIGN KEY ("poll_id") REFERENCES "poll" ("id") ON DELETE CASCADE,
  CONSTRAINT "poll_vote_option_fk" FOREIGN KEY ("option_id") REFERENCES "poll_option" ("id") ON DELETE CASCADE
);
CREATE INDEX "idx_poll_vote_poll" ON "poll_vote" ("poll_id");
CREATE INDEX "idx_poll_vote_option" ON "poll_vote" ("option_id");

CREATE TABLE "poll_comment" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "poll_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "parent_comment_id" UUID,
  "body" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "deleted_at" TIMESTAMPTZ(6),
  CONSTRAINT "poll_comment_pk" PRIMARY KEY ("id"),
  CONSTRAINT "poll_comment_poll_fk" FOREIGN KEY ("poll_id") REFERENCES "poll" ("id") ON DELETE CASCADE,
  CONSTRAINT "poll_comment_parent_fk" FOREIGN KEY ("parent_comment_id") REFERENCES "poll_comment" ("id") ON DELETE CASCADE
);
CREATE INDEX "idx_poll_comment_poll" ON "poll_comment" ("poll_id", "created_at");
CREATE INDEX "idx_poll_comment_parent" ON "poll_comment" ("parent_comment_id");

CREATE TABLE "poll_comment_like" (
  "user_id" UUID NOT NULL,
  "comment_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "poll_comment_like_pk" PRIMARY KEY ("user_id", "comment_id"),
  CONSTRAINT "poll_comment_like_comment_fk" FOREIGN KEY ("comment_id") REFERENCES "poll_comment" ("id") ON DELETE CASCADE
);
CREATE INDEX "idx_poll_comment_like_comment" ON "poll_comment_like" ("comment_id");
