-- 안경 처방전. 굴절값과 따로 쌓는다 - 어떤 안경을 썼는지가 함께 있어야
-- 진행과 견줄 수 있다.
CREATE TABLE "child_prescription" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "parent_child_link_id" UUID NOT NULL,
    "prescribed_on" DATE NOT NULL,
    "sph_od" REAL,
    "sph_os" REAL,
    "cyl_od" REAL,
    "cyl_os" REAL,
    "axis_od" SMALLINT,
    "axis_os" SMALLINT,
    "lens_type" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'parent',
    "memo" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "child_prescription_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "child_prescription_parent_child_link_id_prescribed_on_idx" ON "child_prescription"("parent_child_link_id", "prescribed_on");

ALTER TABLE "child_prescription" ADD CONSTRAINT "child_prescription_parent_child_link_id_fkey" FOREIGN KEY ("parent_child_link_id") REFERENCES "parent_child_link"("id") ON DELETE CASCADE ON UPDATE CASCADE;
