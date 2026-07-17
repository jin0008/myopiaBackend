-- 기관 찾기 (finder): add optional location/contact columns to hospital.
-- Additive + nullable; existing rows and web routes are unaffected.
-- Idempotent (IF NOT EXISTS) so re-runs / partially-migrated DBs stay safe.

ALTER TABLE "hospital" ADD COLUMN IF NOT EXISTS "address"   TEXT;
ALTER TABLE "hospital" ADD COLUMN IF NOT EXISTS "phone"     TEXT;
ALTER TABLE "hospital" ADD COLUMN IF NOT EXISTS "latitude"  DOUBLE PRECISION;
ALTER TABLE "hospital" ADD COLUMN IF NOT EXISTS "longitude" DOUBLE PRECISION;
