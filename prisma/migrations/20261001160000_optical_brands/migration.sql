-- 안경원이 취급하는 근시조절 렌즈 브랜드. 신청할 때 본인이 고르고
-- 운영자가 서류 심사에서 확인한다. 상표라 취급하지 않는 곳에 붙으면
-- 허위 표시가 된다.
ALTER TABLE "hospital_account"
    ADD COLUMN "brands" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "facility_verification"
    ADD COLUMN "brands" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
