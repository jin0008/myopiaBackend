-- 가입 때 문자로 확인한 휴대폰 번호. 번호 하나에 계정 하나.
ALTER TABLE "user" ADD COLUMN "phone" TEXT;
CREATE UNIQUE INDEX "user_phone_key" ON "user"("phone");
