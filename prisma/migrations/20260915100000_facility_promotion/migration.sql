-- 안과·안경점 검색 결과의 유료 노출.
--
-- eye_clinic / optical_shop 에 컬럼을 붙이지 않는다. 그 두 표는 심평원·
-- 지자체 자료를 주기적으로 다시 받아 덮어쓰는 대상이라(scripts/import-facilities.ts),
-- 광고 설정을 함께 두면 자료를 갱신할 때 날아갈 수 있다.
--
-- key 는 안과면 요양기호(ykiho), 안경점이면 인허가번호(license_no) 다.
-- 파트너가 가입할 때 직접 적어 낸 값을 그대로 쓴다 - 상호와 주소로
-- 맞추려 하면 같은 이름이 전국에 여럿이고 도로명/지번이 섞여 틀린다.
CREATE TABLE "facility_promotion" (
    "id"         UUID NOT NULL DEFAULT gen_random_uuid(),
    "kind"       TEXT NOT NULL,
    "key"        TEXT NOT NULL,
    "tier"       TEXT NOT NULL DEFAULT 'premium',
    "starts_at"  TIMESTAMPTZ(6) NOT NULL,
    "ends_at"    TIMESTAMPTZ(6) NOT NULL,
    "account_id" UUID,
    "note"       TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "facility_promotion_pk" PRIMARY KEY ("id")
);

-- 한 시설에 광고는 하나. 기간을 갱신할 때는 같은 줄을 고친다.
CREATE UNIQUE INDEX "facility_promotion_unique" ON "facility_promotion"("kind", "key");

-- 지금 살아 있는 광고만 훑는다.
CREATE INDEX "idx_facility_promotion_active" ON "facility_promotion"("kind", "ends_at");

-- 파트너 계정이 지워져도 광고 이력은 남긴다(정산·분쟁 때 필요).
ALTER TABLE "facility_promotion"
    ADD CONSTRAINT "facility_promotion_account_fk"
    FOREIGN KEY ("account_id") REFERENCES "hospital_account"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
