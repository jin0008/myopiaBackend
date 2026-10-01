-- 리뷰를 그 병원 환자만 쓸 수 있게 했더니 한 건도 쌓이지 않았다. 자격이
-- 너무 좁아 기능이 죽었다. 누구나 쓰되, 환자였는지를 글에 표시한다.

-- 이미 있는 글은 전부 확인된 환자가 쓴 것이다 - 그때는 그 사람만 쓸 수
-- 있었다. 기본값 false 를 먼저 깔고 기존 행만 true 로 올린다.
ALTER TABLE "hospital_review"
    ADD COLUMN "verified_patient" BOOLEAN NOT NULL DEFAULT false;
UPDATE "hospital_review" SET "verified_patient" = true;

-- 환자가 아닌 사람의 글에는 붙일 병원이 없다.
ALTER TABLE "hospital_review" ALTER COLUMN "hospital_id" DROP NOT NULL;
