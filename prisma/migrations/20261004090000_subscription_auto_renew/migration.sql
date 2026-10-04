ALTER TABLE "subscription"
  ADD COLUMN "auto_renew" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "failed_count" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "notified_for" TIMESTAMPTZ(6);

-- 이미 있는 구독은 꺼진 채로 둔다. 카드를 등록한 적이 없으니 켜 두면
-- 청구할 수단도 없이 "자동 갱신 중"으로 보인다.
