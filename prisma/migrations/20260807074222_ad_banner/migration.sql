-- Home/in-app promotional banners (admin-managed, e.g. clinic/treatment ads).
CREATE TABLE "ad_banner" (
    "id"          UUID          NOT NULL DEFAULT gen_random_uuid(),
    "title"       TEXT          NOT NULL,
    "subtitle"    TEXT,
    "badge_text"  TEXT,
    "image_url"   TEXT          NOT NULL,
    "link_url"    TEXT          NOT NULL,
    "placement"   TEXT          NOT NULL DEFAULT 'home',
    "sort_order"  INTEGER       NOT NULL DEFAULT 0,
    "active"      BOOLEAN       NOT NULL DEFAULT true,
    "start_at"    TIMESTAMPTZ(6),
    "end_at"      TIMESTAMPTZ(6),
    "created_by"  UUID,
    "created_at"  TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at"  TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "ad_banner_pk" PRIMARY KEY ("id")
);
CREATE INDEX "ad_banner_placement_idx" ON "ad_banner"("placement", "active", "sort_order");
