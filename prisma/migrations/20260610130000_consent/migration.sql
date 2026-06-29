-- Consent capture for PIPA (개인정보보호법) compliance.
--   user_consent     : account-level consent collected at signup
--                      (이용약관 / 개인정보 수집·이용 / 마케팅 수신).
--   patient_consent  : sensitive-data (민감정보) consent tied to the patient
--                      (the data subject). Currently the legal_guardian basis:
--                      a parent consents when linking a child to a hospital record.
-- Both tables keep a `version` + `agreed_at` so consent to a specific document
-- revision is auditable and re-consent can be detected.

-- CreateEnum
CREATE TYPE "consent_type" AS ENUM ('terms_of_service', 'privacy_policy', 'marketing');

-- CreateEnum
CREATE TYPE "patient_consent_role" AS ENUM ('legal_guardian', 'hospital_attestation');

-- CreateTable: user_consent
CREATE TABLE "user_consent" (
    "id"           UUID           NOT NULL DEFAULT gen_random_uuid(),
    "user_id"      UUID           NOT NULL,
    "consent_type" "consent_type" NOT NULL,
    "version"      TEXT           NOT NULL,
    "agreed"       BOOLEAN        NOT NULL,
    "agreed_at"    TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_consent_pk" PRIMARY KEY ("id")
);

CREATE INDEX "idx_user_consent_user" ON "user_consent"("user_id");

-- CreateTable: patient_consent
CREATE TABLE "patient_consent" (
    "id"         UUID                   NOT NULL DEFAULT gen_random_uuid(),
    "patient_id" UUID                   NOT NULL,
    "given_by"   UUID                   NOT NULL,
    "role"       "patient_consent_role" NOT NULL,
    "version"    TEXT                   NOT NULL,
    "agreed_at"  TIMESTAMPTZ(6)         NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "patient_consent_pk" PRIMARY KEY ("id")
);

CREATE INDEX "idx_patient_consent_patient"  ON "patient_consent"("patient_id");
CREATE INDEX "idx_patient_consent_given_by" ON "patient_consent"("given_by");

-- AddForeignKey
ALTER TABLE "user_consent" ADD CONSTRAINT "user_consent_user_fk"
    FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patient_consent" ADD CONSTRAINT "patient_consent_patient_fk"
    FOREIGN KEY ("patient_id") REFERENCES "patient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patient_consent" ADD CONSTRAINT "patient_consent_user_fk"
    FOREIGN KEY ("given_by") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
