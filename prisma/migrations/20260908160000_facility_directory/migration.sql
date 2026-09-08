-- 전국 안과·안경점 명부.
--
-- 지금까지 지도는 카카오 로컬 검색을 그때그때 프록시했다. 상호명으로
-- 안과인지 추측하는 수준이라, 이름에 "안과"가 없는 의원은 놓치고 종합병원
-- 안에 안과가 있는지는 알 수 없었다.
--
-- 심평원 진료과목(안과 = 코드 12)과 지자체 안경업소 인허가 자료를 받아
-- 우리가 들고 있는다. 출처가 공식 기록이라 "있다/없다"가 확정이고, 안과
-- 전문의 수나 안경점의 검안 장비 수 같은 것도 따라온다.
--
-- 카카오는 그대로 둔다 - 등록되지 않은 곳을 검색할 길이 남아야 한다.

CREATE TABLE "eye_clinic" (
  "id"         UUID NOT NULL DEFAULT gen_random_uuid(),
  -- 심평원 요양기호. 갱신할 때 같은 기관을 알아보는 열쇠다.
  "ykiho"      TEXT NOT NULL,
  "name"       TEXT NOT NULL,
  -- 'university'(상급종합) | 'general'(종합·병원) | 'clinic'(의원)
  "kind"       TEXT NOT NULL,
  "sido"       TEXT NOT NULL,
  "sigungu"    TEXT NOT NULL,
  "address"    TEXT NOT NULL,
  "phone"      TEXT,
  "homepage"   TEXT,
  "lat"        DOUBLE PRECISION NOT NULL,
  "lng"        DOUBLE PRECISION NOT NULL,
  -- 기관 전체 의사 수. 안과 전문의 수는 진료과목 API 를 따로 받아야 한다.
  "doctors"    INTEGER,
  "opened_on"  TEXT,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "eye_clinic_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "eye_clinic_ykiho_key" ON "eye_clinic"("ykiho");
-- 지도는 사각형으로 훑는다. 위도·경도 각각에 인덱스를 둔다.
CREATE INDEX "eye_clinic_lat_lng_idx" ON "eye_clinic"("lat", "lng");
CREATE INDEX "eye_clinic_sido_idx" ON "eye_clinic"("sido", "sigungu");

CREATE TABLE "optical_shop" (
  "id"            UUID NOT NULL DEFAULT gen_random_uuid(),
  -- 지자체 인허가 관리번호.
  "license_no"    TEXT NOT NULL,
  "name"          TEXT NOT NULL,
  "address"       TEXT NOT NULL,
  "phone"         TEXT,
  "lat"           DOUBLE PRECISION NOT NULL,
  "lng"           DOUBLE PRECISION NOT NULL,
  -- 자동굴절검사기 대수. 아이 시력을 재러 가는 부모에게는 이것이 있고
  -- 없고가 실제로 다른 선택이다.
  "refractometer" INTEGER NOT NULL DEFAULT 0,
  "eye_chart"     INTEGER NOT NULL DEFAULT 0,
  "licensed_on"   TEXT,
  "updated_at"    TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "optical_shop_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "optical_shop_license_key" ON "optical_shop"("license_no");
CREATE INDEX "optical_shop_lat_lng_idx" ON "optical_shop"("lat", "lng");
