-- 파트너의 구독과 결제 이력.
--
-- facility_promotion 을 지우지 않는다. 저쪽은 "지금 어느 가게 광고가
-- 걸려 있나"이고 이쪽은 "누가 돈을 내고 있나"다. 운영자가 손으로 걸어
-- 주는 길(무료 제휴, 보상)도 남아야 한다.
CREATE TABLE "subscription" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "account_id" UUID NOT NULL,
    "plan" TEXT NOT NULL DEFAULT 'premium',
    "status" TEXT NOT NULL DEFAULT 'active',
    "billing_key" TEXT,
    "current_period_end" TIMESTAMPTZ(6) NOT NULL,
    "amount" INTEGER NOT NULL,
    "canceled_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "subscription_pk" PRIMARY KEY ("id")
);
-- 한 계정에 구독 하나.
CREATE UNIQUE INDEX "subscription_account_unique" ON "subscription"("account_id");
CREATE INDEX "idx_subscription_due" ON "subscription"("status", "current_period_end");
ALTER TABLE "subscription" ADD CONSTRAINT "subscription_account_fk"
    FOREIGN KEY ("account_id") REFERENCES "hospital_account"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- 성공만 남기지 않는다. 실패도 남아야 "왜 광고가 안 나가느냐"에 답할 수
-- 있고, 같은 주문번호로 두 번 청구하는 일을 막을 수 있다.
CREATE TABLE "payment" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "account_id" UUID NOT NULL,
    "subscription_id" UUID,
    "order_id" TEXT NOT NULL,
    "tid" TEXT,
    "amount" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "pay_method" TEXT,
    "paid_at" TIMESTAMPTZ(6),
    "failed_reason" TEXT,
    "raw" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_pk" PRIMARY KEY ("id")
);
-- 같은 주문번호로 두 번 청구되지 않게 하는 열쇠다.
CREATE UNIQUE INDEX "payment_order_id_key" ON "payment"("order_id");
CREATE INDEX "idx_payment_account" ON "payment"("account_id", "created_at" DESC);
CREATE INDEX "idx_payment_status" ON "payment"("status", "created_at" DESC);
ALTER TABLE "payment" ADD CONSTRAINT "payment_account_fk"
    FOREIGN KEY ("account_id") REFERENCES "hospital_account"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "payment" ADD CONSTRAINT "payment_subscription_fk"
    FOREIGN KEY ("subscription_id") REFERENCES "subscription"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
