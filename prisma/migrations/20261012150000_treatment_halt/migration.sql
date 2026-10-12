-- 치료 목록에 스텔리스트(HALT)를 더한다. 마이오스마트(DIMS)만 있어 스텔리스트를
-- 쓰는 아이는 고를 칸이 없었다. 의사 차트와 마이오닥 앱이 같은 목록을 쓴다.
INSERT INTO "treatment" ("name") VALUES ('HALT') ON CONFLICT ("name") DO NOTHING;
