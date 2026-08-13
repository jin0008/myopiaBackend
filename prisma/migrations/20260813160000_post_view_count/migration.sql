-- Read count for the community "인기글" ranking.
ALTER TABLE "community_post" ADD COLUMN "view_count" INTEGER NOT NULL DEFAULT 0;
