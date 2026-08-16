-- 치료탭이 카카오 검색 대신 우리 프로필을 직접 읽게 되면서, 거리 정렬과
-- 지도 표시에 쓸 좌표가 프로필 안에 있어야 한다. 장소 검색 응답에 이미
-- 들어 있는 값이라 등록 시점에 같이 저장한다.
ALTER TABLE "hospital_profile" ADD COLUMN "latitude" DOUBLE PRECISION;
ALTER TABLE "hospital_profile" ADD COLUMN "longitude" DOUBLE PRECISION;
