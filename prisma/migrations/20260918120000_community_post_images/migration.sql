-- 커뮤니티 글에 사진을 붙인다.
--
-- 주소만 담는다. 파일은 uploads/community 에 있고, 이 칸에는
-- routes/communityUpload.ts 가 내준 주소만 들어온다(검증은 API 에서).
-- 기존 글은 사진이 없는 것이므로 빈 배열로 채운다.
ALTER TABLE "community_post"
    ADD COLUMN "image_urls" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
