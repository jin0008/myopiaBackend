-- 광고 문의. 파트너 모집 페이지에서 로그인 없이 들어온다.
CREATE TABLE "ad_inquiry" (
  "id"           UUID NOT NULL DEFAULT gen_random_uuid(),
  "kind"         TEXT NOT NULL,
  "org"          TEXT NOT NULL,
  "contact_name" TEXT NOT NULL,
  "phone"        TEXT NOT NULL,
  "email"        TEXT NOT NULL,
  "memo"         TEXT,
  "agreed_at"    TIMESTAMPTZ(6) NOT NULL,
  "status"       TEXT NOT NULL DEFAULT 'new',
  "note"         TEXT,
  "created_at"   TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at"   TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "ad_inquiry_pk" PRIMARY KEY ("id")
);

-- 운영자 화면은 늘 "처리 안 된 것부터 최근 순"으로 본다.
CREATE INDEX "idx_ad_inquiry_status" ON "ad_inquiry" ("status", "created_at" DESC);
