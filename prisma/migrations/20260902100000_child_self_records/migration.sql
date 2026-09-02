-- 부모가 직접 남기는 기록.
--
-- 병원 측정은 patient 에 매달려 있어 연동 없이는 아무것도 남길 수 없었다.
-- 연동은 병원 참여에 달려 있어 사용자가 통제할 수 없으므로, 아이에 직접 붙인다.

CREATE TABLE "child_record" (
  "id"                   UUID NOT NULL DEFAULT gen_random_uuid(),
  "parent_child_link_id" UUID NOT NULL,
  "recorded_on"          DATE NOT NULL,
  "axial_od"             REAL,
  "axial_os"             REAL,
  "sph_od"               REAL,
  "sph_os"               REAL,
  "cyl_od"               REAL,
  "cyl_os"               REAL,
  "memo"                 TEXT,
  "created_at"           TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "child_record_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "child_record_link_fk" FOREIGN KEY ("parent_child_link_id")
    REFERENCES "parent_child_link"("id") ON DELETE CASCADE
);
CREATE INDEX "child_record_link_date_idx" ON "child_record"("parent_child_link_id", "recorded_on");

CREATE TABLE "child_care_log" (
  "id"                   UUID NOT NULL DEFAULT gen_random_uuid(),
  "parent_child_link_id" UUID NOT NULL,
  "kind"                 TEXT NOT NULL,
  "done_on"              DATE NOT NULL,
  "created_at"           TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "child_care_log_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "child_care_log_link_fk" FOREIGN KEY ("parent_child_link_id")
    REFERENCES "parent_child_link"("id") ON DELETE CASCADE
);
-- 하루에 한 번만. 두 번 눌러도 한 줄이다.
CREATE UNIQUE INDEX "child_care_log_unique" ON "child_care_log"("parent_child_link_id", "kind", "done_on");
CREATE INDEX "child_care_log_lookup_idx" ON "child_care_log"("parent_child_link_id", "kind", "done_on");

CREATE TABLE "child_reminder" (
  "id"                   UUID NOT NULL DEFAULT gen_random_uuid(),
  "parent_child_link_id" UUID NOT NULL,
  "kind"                 TEXT NOT NULL,
  "due_on"               DATE NOT NULL,
  "memo"                 TEXT,
  "done_at"              TIMESTAMPTZ(6),
  "created_at"           TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "child_reminder_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "child_reminder_link_fk" FOREIGN KEY ("parent_child_link_id")
    REFERENCES "parent_child_link"("id") ON DELETE CASCADE
);
CREATE INDEX "child_reminder_link_due_idx" ON "child_reminder"("parent_child_link_id", "due_on");
