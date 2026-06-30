-- CreateTable
CREATE TABLE "alert_recipient" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "hospital_id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "alert_recipient_pk" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "alert_recipient_hospital_email_unique" ON "alert_recipient"("hospital_id", "email");

-- AddForeignKey
ALTER TABLE "alert_recipient" ADD CONSTRAINT "alert_recipient_hospital_fk" FOREIGN KEY ("hospital_id") REFERENCES "hospital"("id") ON DELETE CASCADE ON UPDATE CASCADE;
