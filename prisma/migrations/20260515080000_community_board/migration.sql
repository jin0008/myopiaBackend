-- Community board (자유게시판) — added for the 수리수리 / EAGLE vision iOS app.
-- Signed-in regular users can post threads, comment, reply, and like.
-- Posts and comments are soft-deleted (deleted_at) so reply chains stay
-- intact and moderation actions are reversible.

-- CreateTable: community_post
CREATE TABLE "community_post" (
    "id"         UUID         NOT NULL DEFAULT gen_random_uuid(),
    "user_id"    UUID         NOT NULL,
    "title"      TEXT         NOT NULL,
    "body"       TEXT         NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "community_post_pk" PRIMARY KEY ("id")
);

CREATE INDEX "idx_community_post_created_at" ON "community_post"("created_at" DESC);
CREATE INDEX "idx_community_post_user"       ON "community_post"("user_id");

-- CreateTable: community_comment (single table — replies are comments with parent_comment_id set)
CREATE TABLE "community_comment" (
    "id"                UUID         NOT NULL DEFAULT gen_random_uuid(),
    "post_id"           UUID         NOT NULL,
    "user_id"           UUID         NOT NULL,
    "parent_comment_id" UUID,
    "body"              TEXT         NOT NULL,
    "created_at"        TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"        TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at"        TIMESTAMPTZ(6),

    CONSTRAINT "community_comment_pk" PRIMARY KEY ("id")
);

CREATE INDEX "idx_community_comment_post"   ON "community_comment"("post_id", "created_at");
CREATE INDEX "idx_community_comment_parent" ON "community_comment"("parent_comment_id");
CREATE INDEX "idx_community_comment_user"   ON "community_comment"("user_id");

-- CreateTable: community_post_like (composite PK = idempotent "liked" state)
CREATE TABLE "community_post_like" (
    "user_id"    UUID         NOT NULL,
    "post_id"    UUID         NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "community_post_like_pk" PRIMARY KEY ("user_id", "post_id")
);

CREATE INDEX "idx_community_post_like_post" ON "community_post_like"("post_id");

-- CreateTable: community_comment_like (composite PK)
CREATE TABLE "community_comment_like" (
    "user_id"    UUID         NOT NULL,
    "comment_id" UUID         NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "community_comment_like_pk" PRIMARY KEY ("user_id", "comment_id")
);

CREATE INDEX "idx_community_comment_like_comment" ON "community_comment_like"("comment_id");

-- AddForeignKey: community_post.user_id → user.id (cascade)
ALTER TABLE "community_post"
    ADD CONSTRAINT "community_post_user_fk"
    FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey: community_comment.user_id → user.id (cascade)
ALTER TABLE "community_comment"
    ADD CONSTRAINT "community_comment_user_fk"
    FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey: community_comment.post_id → community_post.id (cascade)
ALTER TABLE "community_comment"
    ADD CONSTRAINT "community_comment_post_fk"
    FOREIGN KEY ("post_id") REFERENCES "community_post"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey: community_comment.parent_comment_id → community_comment.id (cascade)
ALTER TABLE "community_comment"
    ADD CONSTRAINT "community_comment_parent_fk"
    FOREIGN KEY ("parent_comment_id") REFERENCES "community_comment"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey: community_post_like → user, community_post
ALTER TABLE "community_post_like"
    ADD CONSTRAINT "community_post_like_user_fk"
    FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "community_post_like"
    ADD CONSTRAINT "community_post_like_post_fk"
    FOREIGN KEY ("post_id") REFERENCES "community_post"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey: community_comment_like → user, community_comment
ALTER TABLE "community_comment_like"
    ADD CONSTRAINT "community_comment_like_user_fk"
    FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "community_comment_like"
    ADD CONSTRAINT "community_comment_like_comment_fk"
    FOREIGN KEY ("comment_id") REFERENCES "community_comment"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
