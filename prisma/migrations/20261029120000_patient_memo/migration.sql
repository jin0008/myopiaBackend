-- 병원 내부 환자 메모. 암호화된 값.
ALTER TABLE "patient" ADD COLUMN "encrypted_memo" BYTEA;
