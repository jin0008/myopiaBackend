-- Hospital partner accounts (self-service portal). Sign up → site-admin
-- approves → they manage their own hospital_profile (linked via
-- hospital_profile.owner_account_id).
CREATE TABLE "hospital_account" (
    "id"            UUID           NOT NULL DEFAULT gen_random_uuid(),
    "email"         TEXT           NOT NULL,
    "password_hash" TEXT           NOT NULL,
    "contact_name"  TEXT           NOT NULL,
    "hospital_name" TEXT           NOT NULL,
    "status"        TEXT           NOT NULL DEFAULT 'pending',
    "created_at"    TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at"    TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "hospital_account_pk" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "hospital_account_email_key" ON "hospital_account"("email");
