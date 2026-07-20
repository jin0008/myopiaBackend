-- Community board categories (치료후기/일반). Additive: existing rows default
-- to 'general'. NOT NULL with a default so older clients that don't send a
-- category keep working.
ALTER TABLE "community_post" ADD COLUMN "category" TEXT NOT NULL DEFAULT 'general';

CREATE INDEX "idx_community_post_category" ON "community_post" ("category", "created_at" DESC);
