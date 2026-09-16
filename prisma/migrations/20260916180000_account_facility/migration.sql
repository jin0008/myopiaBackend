-- 파트너 계정이 어느 가게인지.
--
-- 지금까지 이 둘은 이어져 있지 않았다. 계정은 카카오 장소로 식별되는
-- 프로필(hospital_profile)과만 이어져 있고, 광고가 쓰는 심평원 요양기호·
-- 인허가번호와는 무관했다. 그래서 프리미엄 신청에서 자기 가게를 직접
-- 고르게 했는데, 그러면 두 가지가 열린다.
--
--   1. 남의 가게로 신청할 수 있다. 운영자가 승인 때 걸러 내기는 하지만
--      사람이 놓칠 수 있는 자리다.
--   2. 더 나쁜 쪽 - 처리 대기 중인 신청은 시설당 하나뿐이라, 남의 가게로
--      신청만 걸어 두면 진짜 주인이 신청하지 못한다.
--
-- 그래서 가게는 운영자가 계정에 한 번 묶는다. 확인은 어차피 사람이 하는
-- 일이고, 신청할 때마다 할 일이 아니라 계정당 한 번이면 된다.
ALTER TABLE "hospital_account"
    ADD COLUMN "facility_kind" TEXT,
    ADD COLUMN "facility_key"  TEXT;

-- 한 가게에 계정 하나. 두 계정이 같은 가게를 들고 있으면 누구의 광고인지,
-- 누구에게 성적을 보여 줄지가 갈린다.
CREATE UNIQUE INDEX "hospital_account_facility_unique"
    ON "hospital_account"("facility_kind", "facility_key")
    WHERE "facility_key" IS NOT NULL;
