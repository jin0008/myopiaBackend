-- 보호자가 앱에 적은 자녀 키·몸무게. 성장도표(2017 소아청소년 성장도표) 위에 그린다.
-- 둘 중 하나만 재는 날도 있어 둘 다 비울 수 있게 두고, 하나는 있어야 한다는 건 API 가 막는다.
CREATE TABLE "child_growth" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "parent_child_link_id" UUID NOT NULL,
    "measured_on" DATE NOT NULL,
    "height_cm" REAL,
    "weight_kg" REAL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "child_growth_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "child_growth_parent_child_link_id_measured_on_idx" ON "child_growth"("parent_child_link_id", "measured_on");

ALTER TABLE "child_growth" ADD CONSTRAINT "child_growth_parent_child_link_id_fkey" FOREIGN KEY ("parent_child_link_id") REFERENCES "parent_child_link"("id") ON DELETE CASCADE ON UPDATE CASCADE;
