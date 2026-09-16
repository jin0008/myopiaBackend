-- 파트너가 스스로 프리미엄을 신청하고, 운영자가 허락하면 광고가 걸린다.
--
-- 지금까지는 운영자가 어드민에서 직접 등록하는 길 하나뿐이었다. 업체는
-- 전화나 메일로 말하고 운영자가 옮겨 적었는데, 그러다 25자짜리 인허가
-- 번호에서 앞 네 글자가 빠진 채 저장된 일이 있었다.
--
-- 신청과 광고를 한 표로 합치지 않는다. 신청은 "해 달라고 말한 기록"이고
-- 광고는 "지금 걸려 있는 것"이다. 거절된 신청도 남아야 하고, 한 시설이
-- 여러 번 신청할 수 있는데 광고는 시설당 하나다(facility_promotion 의
-- unique(kind,key)). 합치면 그 둘을 한 제약으로 표현할 수 없다.
--
-- 시설(kind,key)을 신청서가 직접 들고 있다. 파트너 계정은 카카오 장소로
-- 식별되는 프로필(hospital_profile)과 이어져 있을 뿐, 심평원 요양기호나
-- 인허가번호와는 이어져 있지 않다. 그래서 "내가 어느 시설인가"는 신청할
-- 때 고르게 하고, 운영자가 승인하며 사람 눈으로 확인한다.
CREATE TABLE "promotion_request" (
    "id"            UUID NOT NULL DEFAULT gen_random_uuid(),
    "account_id"    UUID NOT NULL,
    /* "eye" | "optical" */
    "kind"          TEXT NOT NULL,
    /* 안과면 요양기호(ykiho), 안경점이면 인허가번호(license_no) */
    "key"           TEXT NOT NULL,
    /* 신청 당시의 상호. 명부가 갱신되어 이름이 바뀌어도 무엇을 신청했는지 남는다. */
    "facility_name" TEXT NOT NULL,
    /* 희망 시작일과 개월 수. 실제 기간은 승인할 때 정해진다. */
    "starts_on"     DATE NOT NULL,
    "months"        INTEGER NOT NULL DEFAULT 1,
    /* "pending" | "approved" | "rejected" | "cancelled" */
    "status"        TEXT NOT NULL DEFAULT 'pending',
    "note"          TEXT,
    /* 거절 사유. 파트너 화면에 그대로 보인다. */
    "review_note"   TEXT,
    "reviewed_at"   TIMESTAMPTZ(6),
    "created_at"    TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"    TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "promotion_request_pk" PRIMARY KEY ("id")
);

-- 계정이 지워지면 신청도 함께 지운다. 광고(facility_promotion)와 다르다 -
-- 그쪽은 돈이 오간 기록이라 남기지만, 신청은 아직 아무 일도 아니다.
ALTER TABLE "promotion_request"
    ADD CONSTRAINT "promotion_request_account_fk"
    FOREIGN KEY ("account_id") REFERENCES "hospital_account"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- 운영자 화면은 처리할 것(pending)을 먼저 본다.
CREATE INDEX "idx_promotion_request_status" ON "promotion_request"("status", "created_at" DESC);

-- 파트너 화면은 자기 것만 본다.
CREATE INDEX "idx_promotion_request_account" ON "promotion_request"("account_id", "created_at" DESC);

-- 같은 시설을 두 번 기다리게 두지 않는다. 처리되지 않은 신청은 시설당
-- 하나뿐이어야 운영자가 같은 건을 두 번 승인하는 일이 없다.
CREATE UNIQUE INDEX "promotion_request_one_pending"
    ON "promotion_request"("kind", "key") WHERE "status" = 'pending';
