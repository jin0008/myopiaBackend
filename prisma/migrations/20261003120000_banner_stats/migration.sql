-- 배너 광고의 하루치 성적. promotion_stat_daily 와 같은 모양이다 - 세는
-- 대상이 다를 뿐, 광고를 팔면 "몇 번 보였나"를 줘야 하는 것은 같다.
-- 배너가 지워져도 집계는 남긴다(정산·분쟁). FK 를 걸지 않는 이유다.
CREATE TABLE "banner_stat_daily" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "banner_id" UUID NOT NULL,
    "day" DATE NOT NULL,
    "impressions" INTEGER NOT NULL DEFAULT 0,
    "clicks" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "banner_stat_daily_pk" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "banner_stat_daily_unique" ON "banner_stat_daily"("banner_id", "day");
CREATE INDEX "idx_banner_stat_daily_banner" ON "banner_stat_daily"("banner_id", "day" DESC);
