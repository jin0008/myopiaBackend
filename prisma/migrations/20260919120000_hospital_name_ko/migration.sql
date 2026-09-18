-- 병원 한글 표시 이름.
--
-- name 은 가입 때 입력한 원래 이름으로 그대로 두고, 한글 이름은 새 칸에
-- 따로 둔다. 비어 있으면(NULL) 화면·앱에는 name 이 그대로 보인다.
-- 처음부터 한글로 가입한 병원은 name 이 이미 한글이므로 비워 둔다.
--
-- 추가형 변경이다. 기존 칸과 값은 바꾸지 않는다.
ALTER TABLE "hospital" ADD COLUMN "name_ko" TEXT;

-- 빈 문자열·공백만 있는 값은 NULL 로 저장한다(API 에서 정리해서 넣는다).
ALTER TABLE "hospital"
    ADD CONSTRAINT "hospital_name_ko_not_blank"
    CHECK ("name_ko" IS NULL OR btrim("name_ko") <> '');

-- 병원이름.xlsx 기준 초기값. 한글화할 수 없는 이름(BARUN OPTHALMIC CLINIC,
-- OS Mary, OSSM eye clinic)과 이미 한글인 이름은 넣지 않는다.
-- 해당 이름이 없는 DB(개발용 등)에서는 아무 행도 바뀌지 않는다.
UPDATE "hospital" AS h
SET "name_ko" = m.name_ko
FROM (VALUES
  ('Chung-Ang University', '중앙대병원'),
  ('Chung-Ang University Gwangmyeong Hospital', '중앙대광명병원'),
  ('Comfortable St.Mary''s eye clinic', '눈편한성모안과의원'),
  ('Dabom Eye Clinic', '다봄안과의원'),
  ('Daegu Fatima Hospital', '대구파티마병원'),
  ('Eyemint Eye Clinic', '아이민트안과의원'),
  ('Gil medical center', '길병원'),
  ('Gongdeok eye clinic', '공덕안과의원'),
  ('Hogye Yonsei Eye Clinic', '호계연세안과의원'),
  ('Jeju National University Hospital', '제주대병원'),
  ('Kyung Hee University Hospital at Gangdong', '강동경희대병원'),
  ('L&K miraeeyeclinic', '엘앤케이미래안과의원'),
  ('SMG-SNU Boramae Medical Center', '서울대학교보라매병원'),
  ('Samsung Goodeye Clinic', '삼성굿아이안과'),
  ('Samsung eye clinic', '삼성안과'),
  ('Sanbon Samsung Eye Clinic', '산본삼성안과'),
  ('Segok Bright Eye clinic', '세곡밝은안과'),
  ('Severance Hospital', '세브란스병원'),
  ('Time eye clinic', '타임안과'),
  ('seoul eye clinic', '서울안과')
) AS m(name, name_ko)
WHERE h."name" = m.name AND h."name_ko" IS NULL;
