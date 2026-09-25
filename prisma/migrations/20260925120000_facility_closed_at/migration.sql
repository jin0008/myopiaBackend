-- 명부에서 사라진 기관을 표시한다. 행은 지우지 않는다 - 광고(facility_promotion)와
-- 파트너 계정(hospital_account)이 요양기호·인허가번호를 문자열로 들고 있어,
-- 지우면 참조가 조용히 끊긴다.
ALTER TABLE "eye_clinic"   ADD COLUMN "closed_at" TIMESTAMPTZ;
ALTER TABLE "optical_shop" ADD COLUMN "closed_at" TIMESTAMPTZ;

-- 목록 조회가 늘 "영업 중"만 본다. 부분 인덱스라 작다.
CREATE INDEX "idx_eye_clinic_open"   ON "eye_clinic"   ("ykiho")      WHERE "closed_at" IS NULL;
CREATE INDEX "idx_optical_shop_open" ON "optical_shop" ("license_no") WHERE "closed_at" IS NULL;
