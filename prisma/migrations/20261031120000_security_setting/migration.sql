-- 사이트 전역 보안 설정(항상 id=1 한 줄). 사이트 관리자가 바꾼다.
CREATE TABLE "security_setting" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "web_2fa_enabled" BOOLEAN NOT NULL DEFAULT true,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "security_setting_pk" PRIMARY KEY ("id")
);

INSERT INTO "security_setting" ("id") VALUES (1);
