-- One-line intro, separate from the long description.
ALTER TABLE "hospital_profile" ADD COLUMN "tagline" TEXT;
-- Blog-style body: text and image blocks in order.
ALTER TABLE "hospital_profile" ADD COLUMN "detail_blocks" JSONB;

-- Carry the old single banner into the carousel so nothing disappears.
UPDATE "hospital_profile"
   SET "images" = ARRAY["banner_image_url"]
 WHERE "banner_image_url" IS NOT NULL
   AND coalesce(array_length("images", 1), 0) = 0;
