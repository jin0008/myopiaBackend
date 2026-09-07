-- 치료후기가 어떤 치료에 대한 것인지. 치료탭의 치료별 화면이 후기를 모아
-- 보여주기 위해 필요하다. 기존 글은 태그가 없으므로 NULL 허용.
ALTER TABLE "community_post" ADD COLUMN "treatment_category" TEXT;

CREATE INDEX "idx_community_post_treatment"
  ON "community_post" ("treatment_category", "created_at" DESC);
