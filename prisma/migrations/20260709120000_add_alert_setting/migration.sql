-- Global alert thresholds (singleton row id=1), editable by site admin.
CREATE TABLE "alert_setting" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "axial_min" DOUBLE PRECISION NOT NULL DEFAULT 20.0,
    "axial_max" DOUBLE PRECISION NOT NULL DEFAULT 30.0,
    "axial_decrease_mm" DOUBLE PRECISION NOT NULL DEFAULT 0.3,
    "axial_increase_mm_per_year" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "se_min" DOUBLE PRECISION NOT NULL DEFAULT -6.0,
    "se_progression_d_per_year" DOUBLE PRECISION NOT NULL DEFAULT 0.75,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "alert_setting_pk" PRIMARY KEY ("id")
);

-- Seed the single row with the current defaults.
INSERT INTO "alert_setting" ("id") VALUES (1);
