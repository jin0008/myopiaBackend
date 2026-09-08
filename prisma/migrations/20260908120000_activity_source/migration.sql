-- 이 값을 누가 넣었는지, 그리고 부모 근시의 도수.
--
-- 활동 기록은 보호자가 앱에서 넣는 것과 의사가 진료에서 넣는 것이 같은
-- 칸을 쓴다. 구분이 없으면 의사가 보호자 기록인 줄 모르고 문진하며 고쳐
-- 덮어쓴다 -- 사라지는 것을 아무도 모른다.
--
-- 'parent' | 'clinic'. 이 칸이 생기기 전 행은 알 수 없으므로 NULL 이다.
ALTER TABLE "patient_nearwork_activity" ADD COLUMN "source" TEXT;
ALTER TABLE "patient_outdoor_activity" ADD COLUMN "source" TEXT;

-- 부모 근시 도수. 앱에서는 이미 받고 있는데 의사 화면에는 보일 자리가
-- 없었다. 아는 부모만 적으므로 NULL 을 허용한다.
ALTER TABLE "patient_parental_myopia_status" ADD COLUMN "sph_od" REAL;
ALTER TABLE "patient_parental_myopia_status" ADD COLUMN "sph_os" REAL;
