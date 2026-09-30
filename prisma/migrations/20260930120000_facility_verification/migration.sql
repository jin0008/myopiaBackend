-- 업체 인증 신청. 파트너가 명부에서 자기 가게를 고르고 서류를 올리면
-- 운영자가 대조해 승인한다. 승인이 곧 계정↔업체 1:1 연결이다.
CREATE TABLE "facility_verification" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "account_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "facility_name" TEXT NOT NULL,
    -- 파일명만 담는다. 공개 URL 이 아니다.
    "doc_files" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "status" TEXT NOT NULL DEFAULT 'pending',
    "note" TEXT,
    "review_note" TEXT,
    "reviewed_at" TIMESTAMPTZ(6),
    "reviewed_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "facility_verification_pk" PRIMARY KEY ("id")
);

CREATE INDEX "idx_facility_verification_status"
    ON "facility_verification"("status", "created_at" DESC);
CREATE INDEX "idx_facility_verification_account"
    ON "facility_verification"("account_id", "created_at" DESC);

-- 한 계정에 처리 대기 중인 신청은 하나. 여러 건이 쌓이면 운영자가
-- 어느 것을 보고 승인했는지 알 수 없다.
CREATE UNIQUE INDEX "facility_verification_one_pending"
    ON "facility_verification"("account_id") WHERE "status" = 'pending';

ALTER TABLE "facility_verification"
    ADD CONSTRAINT "facility_verification_account_fk"
    FOREIGN KEY ("account_id") REFERENCES "hospital_account"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
