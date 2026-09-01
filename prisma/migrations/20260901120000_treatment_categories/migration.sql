-- 병원이 하는 치료를 별도 컬럼으로 뺀다.
--
-- 지금까지는 treatment_items 안의 category 를 훑어 치료탭 필터를 걸었다.
-- 그래서 가격표를 올리지 않은 병원은 그 치료를 해도 검색되지 않았다.
ALTER TABLE "hospital_profile"
  ADD COLUMN "treatment_categories" TEXT[] NOT NULL DEFAULT '{}';

-- 기존 프로필이 검색에서 사라지지 않도록 category 를 옮겨 담는다.
-- 지금까지 이 값이 곧 필터 기준이었으므로 그대로 이관하면 결과가 같다.
UPDATE "hospital_profile" p
SET "treatment_categories" = sub.cats
FROM (
  SELECT h.id,
         array_agg(DISTINCT e.value ->> 'category')
           FILTER (WHERE nullif(trim(e.value ->> 'category'), '') IS NOT NULL) AS cats
  FROM "hospital_profile" h,
       LATERAL jsonb_array_elements(h.treatment_items::jsonb) AS e(value)
  WHERE h.treatment_items IS NOT NULL
    AND jsonb_typeof(h.treatment_items::jsonb) = 'array'
  GROUP BY h.id
) sub
WHERE p.id = sub.id
  AND sub.cats IS NOT NULL;
