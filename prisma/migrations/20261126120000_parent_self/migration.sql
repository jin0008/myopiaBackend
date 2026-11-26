-- 보호자 본인 프로필. 본인 안경처방전을 아이와 같은 길(병원 연동·직접 입력)로 담는다.
ALTER TABLE "parent_child_link" ADD COLUMN "is_self" BOOLEAN NOT NULL DEFAULT false;
-- 사람마다 본인은 하나.
CREATE UNIQUE INDEX "parent_child_link_one_self" ON "parent_child_link" ("user_id") WHERE "is_self";

-- 환자 본인이 자기 기록을 이을 때의 동의 주체.
ALTER TYPE "patient_consent_role" ADD VALUE 'patient';
