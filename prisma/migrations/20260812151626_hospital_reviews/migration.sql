-- hospital_profile: 모두닥-style card fields + internal hospital link
ALTER TABLE "hospital_profile"
  ADD COLUMN "hospital_id" UUID,
  ADD COLUMN "thumbnail_url" TEXT,
  ADD COLUMN "keywords" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "treatment_items" JSONB,
  ADD COLUMN "verified" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "booking_url" TEXT;

-- hospital_review: app-user reviews, one per (place, user)
CREATE TABLE "hospital_review" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "kakao_place_id" TEXT NOT NULL,
  "user_id" UUID NOT NULL,
  "hospital_id" UUID NOT NULL,
  "rating" INTEGER NOT NULL,
  "content" TEXT NOT NULL,
  "images" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "status" TEXT NOT NULL DEFAULT 'visible',
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "hospital_review_pk" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "hospital_review_place_user_unique" ON "hospital_review" ("kakao_place_id", "user_id");
CREATE INDEX "idx_hospital_review_place" ON "hospital_review" ("kakao_place_id");
