ALTER TABLE "facility_promotion"
  ADD COLUMN "region_code" TEXT,
  ADD COLUMN "region_name" TEXT;

-- 이미 걸려 있는 광고는 비워 둔다. 좌표로 카카오에 물어야 채워지는 값이라
-- 마이그레이션이 할 수 있는 일이 아니다. 자리를 볼 때 비어 있는 것을 만나면
-- 그 자리에서 채운다(promotionSlots.ts).

-- 같은 업종, 같은 동에 둘은 걸리지 않는다.
--
-- 코드로만 막으면 막히지 않는다. 두 업체가 같은 때에 결제를 끝내면 둘 다
-- "비어 있다"를 보고 지나가고, 둘 다에게 독점이라고 말한 꼴이 된다. 그것은
-- 환불로도 되돌릴 수 없다. 마지막 자는 여기다.
--
-- NULL 끼리는 겹치지 않으므로(SQL 기본), 동을 아직 모르는 광고와 기간이
-- 끝나 자리를 내놓은 광고는 이 자에 걸리지 않는다.
CREATE UNIQUE INDEX "facility_promotion_region_unique"
  ON "facility_promotion" ("kind", "region_code");
