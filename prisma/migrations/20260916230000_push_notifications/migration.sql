-- 폰으로 알림을 보낸다.
--
-- 지금까지 알림은 notification 표에 쌓이기만 했다. 앱을 열어야 보이니,
-- 댓글이 달린 것도 진료 예정일도 그날 알 수가 없다. 매일 밤 넣어야 하는
-- 아트로핀은 특히 그렇다 - 앱은 "넣었으면 체크하세요"라고만 하고 정작
-- 넣을 시간은 말해 주지 않았다.

-- 기기 하나에 토큰 하나. 한 사람이 폰과 태블릿을 함께 쓸 수 있어
-- 사용자당 여러 줄이 된다.
CREATE TABLE "push_token" (
    "id"         UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id"    UUID NOT NULL,
    /* Expo 푸시 토큰(ExponentPushToken[...]). 애플·구글 토큰을 직접 들지
       않는 이유는 Expo 가 그 둘을 가려 주기 때문이다. */
    "token"      TEXT NOT NULL,
    /* "ios" | "android" — 보낼 때가 아니라 문제를 쫓을 때 쓴다. */
    "platform"   TEXT,
    /* 앱이 켜질 때마다 갱신한다. 오래 안 보인 토큰은 지운 앱이다. */
    "last_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "push_token_pk" PRIMARY KEY ("id")
);

-- 같은 토큰이 두 사용자에게 붙을 수 있다. 기기를 물려주거나 한 폰에서
-- 계정을 바꿔 로그인하면 그렇다. 그때는 마지막 사람 것이어야 하므로
-- 토큰 자체를 유일하게 두고, 다시 등록되면 주인을 바꾼다.
CREATE UNIQUE INDEX "push_token_unique" ON "push_token"("token");
CREATE INDEX "idx_push_token_user" ON "push_token"("user_id");

ALTER TABLE "push_token"
    ADD CONSTRAINT "push_token_user_fk"
    FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- 무엇을 받을지. 사용자당 한 줄이고, 줄이 없으면 전부 받는 것으로 본다 -
-- 기존 사용자에게 기본값 줄을 미리 만들어 두지 않아도 된다.
CREATE TABLE "notification_pref" (
    "user_id"    UUID NOT NULL,
    /* 커뮤니티: 내 글의 댓글·답글·좋아요 */
    "community"  BOOLEAN NOT NULL DEFAULT true,
    /* 매일 하는 치료를 아직 체크하지 않았을 때 */
    "care_daily" BOOLEAN NOT NULL DEFAULT true,
    /* 그 시각(KST)에 보낸다. 분 단위로 두면 한 사람마다 다른 분에 깨워야
       한다. 정시로 제한해 크론이 한 시간에 한 번만 돌게 한다. */
    "care_hour"  INTEGER NOT NULL DEFAULT 21,
    /* 잊지 마세요: 진료 예정일·렌즈 교체일 */
    "reminder"   BOOLEAN NOT NULL DEFAULT true,
    /* 병원 연동 해제처럼 반드시 알려야 하는 것. 끄지 못한다 - 예고 없이
       차트에서 측정값이 사라지는 일이라 모르고 지나가면 안 된다. */
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "notification_pref_pk" PRIMARY KEY ("user_id")
);

ALTER TABLE "notification_pref"
    ADD CONSTRAINT "notification_pref_user_fk"
    FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- 같은 알림을 두 번 보내지 않기 위한 자국.
--
-- 크론은 한 시간에 한 번 도는데, 서버가 재시작되거나 실행이 겹치면 같은
-- 날 같은 사람에게 두 번 갈 수 있다. "무엇을, 누구에게, 어느 날" 을
-- 유일하게 두고 먼저 꽂아 본 쪽만 보낸다.
CREATE TABLE "push_sent" (
    "user_id" UUID NOT NULL,
    /* "care_daily" | "reminder:<child_reminder.id>" */
    "kind"    TEXT NOT NULL,
    "day"     DATE NOT NULL,
    "sent_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "push_sent_pk" PRIMARY KEY ("user_id", "kind", "day")
);

ALTER TABLE "push_sent"
    ADD CONSTRAINT "push_sent_user_fk"
    FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
