-- Opening hours (clinic-entered; no map API supplies them) and clinic notices.
ALTER TABLE "hospital_profile" ADD COLUMN "opening_hours" JSONB;

CREATE TABLE "hospital_notice" (
  "id"         UUID NOT NULL DEFAULT gen_random_uuid(),
  "profile_id" UUID NOT NULL,
  "title"      TEXT NOT NULL,
  "body"       TEXT NOT NULL,
  "kind"       TEXT NOT NULL DEFAULT 'notice',
  "pinned"     BOOLEAN NOT NULL DEFAULT false,
  "published"  BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "hospital_notice_pk" PRIMARY KEY ("id"),
  CONSTRAINT "hospital_notice_profile_fk" FOREIGN KEY ("profile_id")
    REFERENCES "hospital_profile"("id") ON DELETE CASCADE
);
CREATE INDEX "idx_hospital_notice_profile"
  ON "hospital_notice" ("profile_id", "pinned", "created_at" DESC);
