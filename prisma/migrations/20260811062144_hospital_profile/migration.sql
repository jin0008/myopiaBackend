-- Marketing profile for a finder hospital (banner + description + gallery),
-- keyed to the Kakao place the finder results come from. Admin/partner-managed.
CREATE TABLE "hospital_profile" (
    "id"               UUID           NOT NULL DEFAULT gen_random_uuid(),
    "kakao_place_id"   TEXT           NOT NULL,
    "name"             TEXT           NOT NULL,
    "description"      TEXT,
    "banner_image_url" TEXT,
    "images"           TEXT[]         NOT NULL DEFAULT '{}',
    "phone"            TEXT,
    "address"          TEXT,
    "status"           TEXT           NOT NULL DEFAULT 'published',
    "owner_account_id" UUID,
    "created_by"       UUID,
    "created_at"       TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at"       TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "hospital_profile_pk" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "hospital_profile_kakao_place_id_key" ON "hospital_profile"("kakao_place_id");
