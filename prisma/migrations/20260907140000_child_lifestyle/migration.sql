-- 부모가 직접 넣는 생활습관과 부모 근시.
--
-- 지금까지 두 가지 모두 patient 에 매달려 있어 병원 연동 없이는 저장할
-- 곳이 없었다. 연동은 병원 참여에 달려 있어 사용자가 통제할 수 없다.
-- child_record 와 같은 자리(parent_child_link)에 붙인다.
--
-- 연동된 아이는 여기에 쓰면서 patient 쪽에도 그대로 내보낸다. 의사 화면이
-- 보는 곳이 patient 이기 때문이다.

CREATE TABLE "child_activity_log" (
  "id"                   UUID NOT NULL DEFAULT gen_random_uuid(),
  "parent_child_link_id" UUID NOT NULL,
  -- 'nearwork' | 'outdoor'
  "kind"                 TEXT NOT NULL,
  "hours"                INTEGER NOT NULL,
  "recorded_at"          TIMESTAMPTZ(6) NOT NULL,
  "created_at"           TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "child_activity_log_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "child_activity_log_link_fk" FOREIGN KEY ("parent_child_link_id")
    REFERENCES "parent_child_link"("id") ON DELETE CASCADE
);
CREATE INDEX "child_activity_log_lookup_idx"
  ON "child_activity_log"("parent_child_link_id", "kind", "recorded_at" DESC);

-- 부모 근시는 현재값 하나만 둔다. 시간이 지나도 바뀌는 값이 아니라서
-- 이력을 쌓을 이유가 없다(기존 patient 쪽 처리와 같다).
CREATE TABLE "child_parental_myopia" (
  "id"                   UUID NOT NULL DEFAULT gen_random_uuid(),
  "parent_child_link_id" UUID NOT NULL,
  -- 'male' | 'female'
  "parent_sex"           TEXT NOT NULL,
  -- 'myopia' | 'high_myopia' | 'emmetropia' | 'hyperopia' | 'unknown'
  "status"               TEXT NOT NULL,
  "recorded_at"          TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "child_parental_myopia_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "child_parental_myopia_link_fk" FOREIGN KEY ("parent_child_link_id")
    REFERENCES "parent_child_link"("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "child_parental_myopia_unique"
  ON "child_parental_myopia"("parent_child_link_id", "parent_sex");
