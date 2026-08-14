-- 병원 상세의 '의사 정보' 섹션. 원장·전문의 목록은 병원마다 인원이 다르고
-- 순서(대표원장 먼저)가 의미를 가지므로 배열 JSON으로 둔다. detail_blocks,
-- opening_hours와 같은 방식.
-- [{ name, title?, photoUrl?, bio? }]
ALTER TABLE "hospital_profile" ADD COLUMN "doctors" JSONB;
