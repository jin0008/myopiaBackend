-- 보호자가 앱에 적은 치료 이력. 병원 치료 목록(treatment)을 그대로 쓴다.
CREATE TABLE "child_treatment" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "parent_child_link_id" UUID NOT NULL,
    "treatment_id" UUID NOT NULL,
    "start_date" DATE NOT NULL,
    "end_date" DATE,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "child_treatment_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "child_treatment_parent_child_link_id_start_date_idx" ON "child_treatment"("parent_child_link_id", "start_date");

ALTER TABLE "child_treatment" ADD CONSTRAINT "child_treatment_parent_child_link_id_fkey" FOREIGN KEY ("parent_child_link_id") REFERENCES "parent_child_link"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "child_treatment" ADD CONSTRAINT "child_treatment_treatment_id_fkey" FOREIGN KEY ("treatment_id") REFERENCES "treatment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
