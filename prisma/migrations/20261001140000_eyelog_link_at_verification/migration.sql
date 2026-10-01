-- 아이로그 연동을 인증 심사에서 함께 정한다. 그동안 운영자가 "병원 프로필
-- 관리 → 관리자 설정"까지 따로 들어가야 했고, 그 자리를 빼먹으면 병원은
-- 후기가 왜 안 되는지 알 수 없었다.
ALTER TABLE "hospital_account" ADD COLUMN "eyelog_hospital_id" UUID;
ALTER TABLE "facility_verification" ADD COLUMN "eyelog_code" TEXT;
