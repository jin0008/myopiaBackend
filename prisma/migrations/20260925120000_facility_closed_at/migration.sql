-- 명부에서 사라진 기관을 표시한다. 행은 지우지 않는다 - 광고(facility_promotion)와
-- 파트너 계정(hospital_account)이 요양기호·인허가번호를 문자열로 들고 있어,
-- 지우면 참조가 조용히 끊긴다.
--
-- 인덱스는 두지 않는다. 이 컬럼을 보는 조회는 이름·주소의 부분일치 검색에
-- 곁들여 거르는 것뿐인데, 앞이 열린 LIKE 는 btree 를 타지 못한다 - 인덱스를
-- 만들어도 쓰이지 않고 쓰기 비용만 는다.
ALTER TABLE "eye_clinic"   ADD COLUMN "closed_at" TIMESTAMPTZ(6);
ALTER TABLE "optical_shop" ADD COLUMN "closed_at" TIMESTAMPTZ(6);
