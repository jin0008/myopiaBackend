-- 유료 노출이 얼마나 보였고 얼마나 눌렸는지.
--
-- 돈을 받으면 "이번 달 몇 번 노출됐냐"는 질문이 바로 온다. 지금은 답할
-- 데이터가 없다. 광고는 이미 나가는 중이라 하루라도 빨리 남기기 시작하는
-- 편이 낫다 - 지나간 날은 되돌려 셀 수 없다.
--
-- facility_promotion 을 가리키는 FK 를 두지 않는다. 광고는 지워지거나
-- 기간이 끝나도 집계는 남아야 한다(정산·분쟁). 시설(kind+key)이 변하지
-- 않는 신원이고, 광고는 그 위를 스쳐 가는 기간일 뿐이다.
--
-- 한 줄에 한 시설의 하루. 이벤트를 낱개로 쌓지 않는 이유는 노출이 너무
-- 잦아서다 - 목록을 한 번 그릴 때마다 최대 3줄이 생기고, 스크롤하면 또
-- 생긴다. 낱개로 두면 한 달이면 수백만 줄이 되는데, 우리가 보여줄 것은
-- 결국 "그날 몇 번"이다.
CREATE TABLE "promotion_stat_daily" (
    "id"          UUID NOT NULL DEFAULT gen_random_uuid(),
    /* "eye" | "optical" — facility_promotion.kind 와 같은 뜻 */
    "kind"        TEXT NOT NULL,
    /* 안과면 요양기호(ykiho), 안경점이면 인허가번호(license_no) */
    "key"         TEXT NOT NULL,
    /* 집계 날짜(KST 기준). 광고주가 보는 달력이 한국 달력이다. */
    "day"         DATE NOT NULL,
    "impressions" INTEGER NOT NULL DEFAULT 0,
    "clicks"      INTEGER NOT NULL DEFAULT 0,
    "created_at"  TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"  TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "promotion_stat_daily_pk" PRIMARY KEY ("id")
);

-- 하루 한 줄. 들어오는 이벤트는 이 제약을 타고 UPSERT 로 더해진다.
CREATE UNIQUE INDEX "promotion_stat_daily_unique"
    ON "promotion_stat_daily"("kind", "key", "day");

-- 한 시설의 기간별 조회가 거의 전부다(파트너 화면, 어드민 목록).
CREATE INDEX "idx_promotion_stat_daily_facility"
    ON "promotion_stat_daily"("kind", "key", "day" DESC);
