-- CreateTable: parent_child_link
-- Links an app user (normal_user) to one or more children they track.
CREATE TABLE "parent_child_link" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "nickname" TEXT NOT NULL,
    "date_of_birth" DATE NOT NULL,
    "sex" "sex" NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "parent_child_link_pk" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "idx_parent_child_link_user" ON "parent_child_link"("user_id");

-- CreateTable: child_hospital_link
-- Connects a parent's child profile to a real hospital patient record.
-- On parent_child_link cascade delete, the patient + measurements are preserved
-- at the hospital (no cascade on patient).
CREATE TABLE "child_hospital_link" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "parent_child_link_id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "linked_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "child_hospital_link_pk" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "child_hospital_link_unique" ON "child_hospital_link"("parent_child_link_id", "hospital_id");

-- CreateTable: mobile_refresh_token
-- Stores sha256 hashes of opaque refresh tokens for the mobile app.
CREATE TABLE "mobile_refresh_token" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rotated_from" UUID,
    "revoked_at" TIMESTAMPTZ(6),

    CONSTRAINT "mobile_refresh_token_pk" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "mobile_refresh_token_hash_unique" ON "mobile_refresh_token"("token_hash");
CREATE INDEX "idx_refresh_user" ON "mobile_refresh_token"("user_id");

-- CreateTable: oauth_identity
-- Unified table for Apple / Google / Kakao / Naver social identities used by the app.
-- Kept separate from the existing web-only google_auth table.
CREATE TABLE "oauth_identity" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "oauth_identity_pk" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "oauth_identity_provider_subject_unique" ON "oauth_identity"("provider", "subject");

-- AddForeignKey: parent_child_link → user (cascade on user delete)
ALTER TABLE "parent_child_link"
    ADD CONSTRAINT "parent_child_link_user_fk"
    FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey: child_hospital_link → parent_child_link (cascade)
ALTER TABLE "child_hospital_link"
    ADD CONSTRAINT "child_hospital_link_parent_child_link_fk"
    FOREIGN KEY ("parent_child_link_id") REFERENCES "parent_child_link"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey: child_hospital_link → hospital (no cascade)
ALTER TABLE "child_hospital_link"
    ADD CONSTRAINT "child_hospital_link_hospital_fk"
    FOREIGN KEY ("hospital_id") REFERENCES "hospital"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey: child_hospital_link → patient (no cascade — patient is preserved)
ALTER TABLE "child_hospital_link"
    ADD CONSTRAINT "child_hospital_link_patient_fk"
    FOREIGN KEY ("patient_id") REFERENCES "patient"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey: mobile_refresh_token → user (cascade)
ALTER TABLE "mobile_refresh_token"
    ADD CONSTRAINT "mobile_refresh_token_user_fk"
    FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey: mobile_refresh_token.rotated_from → mobile_refresh_token(id)
ALTER TABLE "mobile_refresh_token"
    ADD CONSTRAINT "mobile_refresh_token_rotated_from_fk"
    FOREIGN KEY ("rotated_from") REFERENCES "mobile_refresh_token"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey: oauth_identity → user (cascade)
ALTER TABLE "oauth_identity"
    ADD CONSTRAINT "oauth_identity_user_fk"
    FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
