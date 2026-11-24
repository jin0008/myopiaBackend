-- 병원이 발행하는 안경 처방전. 보호자 입력(child_prescription)과 따로 둔다 -
-- 인쇄물로 나가는 공식 기록이라 보호자가 고칠 수 없어야 한다.
-- 발행 의료인 계정이 지워져도 처방은 남는다(이름을 따로 적어 둔다).

CREATE TABLE "patient_prescription" (
  "id"              UUID NOT NULL DEFAULT gen_random_uuid(),
  "patient_id"      UUID NOT NULL,
  "hospital_id"     UUID NOT NULL,
  "prescriber_id"   UUID,
  "prescriber_name" TEXT NOT NULL,
  "prescribed_on"   DATE NOT NULL,

  "far_sph_od"   REAL,
  "far_sph_os"   REAL,
  "far_cyl_od"   REAL,
  "far_cyl_os"   REAL,
  "far_axis_od"  SMALLINT,
  "far_axis_os"  SMALLINT,
  "far_prism_od" REAL,
  "far_prism_os" REAL,
  "far_base_od"  VARCHAR(2),
  "far_base_os"  VARCHAR(2),

  "near_sph_od"   REAL,
  "near_sph_os"   REAL,
  "near_cyl_od"   REAL,
  "near_cyl_os"   REAL,
  "near_axis_od"  SMALLINT,
  "near_axis_os"  SMALLINT,
  "near_prism_od" REAL,
  "near_prism_os" REAL,
  "near_base_od"  VARCHAR(2),
  "near_base_os"  VARCHAR(2),

  "pd_far"  REAL,
  "pd_near" REAL,
  "add_od"  REAL,
  "add_os"  REAL,

  "note"       TEXT,
  -- REMARKS 칩으로 고른 것(렌즈 제품·용도). 자유 문구와 따로 남겨야 어떤 렌즈가
  -- 얼마나 처방되는지 셀 수 있다.
  "remark_tags" TEXT[] NOT NULL DEFAULT '{}',
  "prescriber_license" TEXT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

  CONSTRAINT "patient_prescription_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "patient_prescription_patient_id_fkey" FOREIGN KEY ("patient_id")
    REFERENCES "patient"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "patient_prescription_hospital_id_fkey" FOREIGN KEY ("hospital_id")
    REFERENCES "hospital"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "patient_prescription_prescriber_id_fkey" FOREIGN KEY ("prescriber_id")
    REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX "patient_prescription_patient_id_prescribed_on_idx" ON "patient_prescription"("patient_id", "prescribed_on" DESC);
CREATE INDEX "patient_prescription_hospital_id_created_at_idx" ON "patient_prescription"("hospital_id", "created_at" DESC);

-- 병원별 처방전 양식(병원명·주소·로고·처방의 목록·면허번호·도장·안내 문구 등).
-- 진료실 PC 마다 따로 두면 의사마다 양식이 달라져 병원 단위로 둔다.
CREATE TABLE "hospital_rx_setting" (
  "hospital_id" UUID NOT NULL,
  "settings"    JSONB NOT NULL,
  "updated_at"  TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_by"  UUID,
  CONSTRAINT "hospital_rx_setting_pkey" PRIMARY KEY ("hospital_id"),
  CONSTRAINT "hospital_rx_setting_hospital_id_fkey" FOREIGN KEY ("hospital_id")
    REFERENCES "hospital"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
