-- 병원이 부모에게 건네는 일회용 연동 초대.
--
-- 지금은 부모가 병원 등록번호를 직접 입력해 연동한다. 등록번호는 대개
-- 연속된 숫자라 비밀 노릇을 못 하고, 생년월일·성별만 맞으면 통과하므로
-- 남의 아이 진료 기록에 붙을 여지가 있다.
--
-- 추측할 수 있는 값을 묻는 대신, 병원이 줄 수만 있는 표를 건넨다.
-- 토큰은 해시로만 저장한다 — DB 를 들여다봐도 링크를 되만들 수 없어야 한다.

CREATE TABLE "child_link_invite" (
  "id"          UUID NOT NULL DEFAULT gen_random_uuid(),
  "hospital_id" UUID NOT NULL,
  "patient_id"  UUID NOT NULL,
  "token_hash"  TEXT NOT NULL,
  -- 누가 초대했는지. 사고가 났을 때 되짚을 수 있어야 한다.
  "created_by"  UUID NOT NULL,
  "created_at"  TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "expires_at"  TIMESTAMPTZ(6) NOT NULL,
  -- 한 번 쓰면 끝. 누가 썼는지도 남긴다.
  "used_at"     TIMESTAMPTZ(6),
  "used_by"     UUID,
  "revoked_at"  TIMESTAMPTZ(6),
  CONSTRAINT "child_link_invite_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "child_link_invite_hospital_fk" FOREIGN KEY ("hospital_id")
    REFERENCES "hospital"("id") ON DELETE CASCADE,
  CONSTRAINT "child_link_invite_patient_fk" FOREIGN KEY ("patient_id")
    REFERENCES "patient"("id") ON DELETE CASCADE,
  CONSTRAINT "child_link_invite_creator_fk" FOREIGN KEY ("created_by")
    REFERENCES "user"("id") ON DELETE RESTRICT,
  CONSTRAINT "child_link_invite_user_fk" FOREIGN KEY ("used_by")
    REFERENCES "user"("id") ON DELETE SET NULL
);

CREATE UNIQUE INDEX "child_link_invite_token_key" ON "child_link_invite"("token_hash");
CREATE INDEX "child_link_invite_patient_idx" ON "child_link_invite"("patient_id", "created_at" DESC);
