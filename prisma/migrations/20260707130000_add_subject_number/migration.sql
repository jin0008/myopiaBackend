-- Add de-identified subject number to study_enrollment.
ALTER TABLE "study_enrollment" ADD COLUMN "subject_number" VARCHAR;

-- Backfill existing enrollments: {studyCode}-{hospitalCode}-{seq}, numbered per
-- (study, hospital) in enrollment order. Codes uppercased; missing study code
-- falls back to 'S'.
WITH numbered AS (
  SELECT
    e."id",
    regexp_replace(upper(coalesce(s."code", 'S')), '\s+', '', 'g')
      || '-' || regexp_replace(upper(h."code"), '\s+', '', 'g')
      || '-' || lpad(
        (row_number() OVER (
          PARTITION BY e."study_id", p."hospital_id"
          ORDER BY e."enrolled_at", e."id"
        ))::text, 3, '0') AS num
  FROM "study_enrollment" e
  JOIN "study" s ON s."id" = e."study_id"
  JOIN "patient" p ON p."id" = e."patient_id"
  JOIN "hospital" h ON h."id" = p."hospital_id"
)
UPDATE "study_enrollment" e
SET "subject_number" = n.num
FROM numbered n
WHERE n."id" = e."id";

-- Unique per study (subject_number embeds the study + hospital code already).
-- Multiple NULLs remain allowed (Postgres treats NULLs as distinct).
CREATE UNIQUE INDEX "study_enrollment_subject_unique"
  ON "study_enrollment" ("study_id", "subject_number");
