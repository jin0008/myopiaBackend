-- Expert columns table (admin-authored reading material).
CREATE TABLE "expert_column" (
    "id"              UUID          NOT NULL DEFAULT gen_random_uuid(),
    "slug"            TEXT          NOT NULL,
    "title"           TEXT          NOT NULL,
    "body"            TEXT          NOT NULL,
    "category"        TEXT          NOT NULL,
    "author"          TEXT          NOT NULL DEFAULT '마이오닥 의료진',
    "author_role"     TEXT          NOT NULL DEFAULT '안과 감수',
    "thumbnail_emoji" TEXT          NOT NULL DEFAULT '📄',
    "published"       BOOLEAN       NOT NULL DEFAULT true,
    "published_at"    TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "created_by"      UUID,
    "created_at"      TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at"      TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "expert_column_pk" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "expert_column_slug_key" ON "expert_column"("slug");
