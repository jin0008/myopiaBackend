-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";
-- CreateEnum
CREATE TYPE "sex" AS ENUM ('male', 'female');
-- CreateEnum
CREATE TYPE "ktype" AS ENUM ('K1', 'K2');
-- CreateTable
CREATE TABLE "country" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "code" VARCHAR(2) NOT NULL,
    CONSTRAINT "country_pk" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "ethnicity" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" VARCHAR(25) NOT NULL,
    CONSTRAINT "ethnicity_pk" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "healthcare_professional" (
    "name" TEXT NOT NULL,
    "country_id" UUID NOT NULL,
    "approved" BOOLEAN NOT NULL DEFAULT false,
    "hospital_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "default_ethnicity_id" UUID,
    "default_instrument_id" UUID,
    "is_admin" BOOLEAN NOT NULL DEFAULT false,
    "role" VARCHAR NOT NULL,
    CONSTRAINT "healthcare_professional_pk" PRIMARY KEY ("user_id")
);
-- CreateTable
CREATE TABLE "hospital" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "country_id" UUID NOT NULL,
    "code" VARCHAR NOT NULL,
    CONSTRAINT "hospital_pk" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "instrument" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" VARCHAR(20) NOT NULL,
    CONSTRAINT "instrument_pk" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "measurement" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "patient_id" UUID NOT NULL,
    "date" DATE NOT NULL,
    "instrument_id" UUID NOT NULL,
    "creator_id" UUID NOT NULL,
    "od" REAL,
    "os" REAL,
    CONSTRAINT "measurement_pk" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "normal_user" (
    "user_id" UUID NOT NULL,
    CONSTRAINT "normal_user_pk" PRIMARY KEY ("user_id")
);
-- CreateTable
CREATE TABLE "password_auth" (
    "user_id" UUID NOT NULL,
    "username" VARCHAR NOT NULL,
    "hash" VARCHAR NOT NULL,
    CONSTRAINT "password_auth_pk" PRIMARY KEY ("user_id")
);
-- CreateTable
CREATE TABLE "patient" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "hospital_id" UUID NOT NULL,
    "registration_number" TEXT NOT NULL,
    "date_of_birth" DATE NOT NULL,
    "sex" "sex" NOT NULL,
    "ethnicity_id" UUID NOT NULL,
    "creator_id" UUID,
    "email" TEXT,
    CONSTRAINT "patient_pk" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "patient_treatment" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "patient_id" UUID NOT NULL,
    "treatment_id" UUID NOT NULL,
    "start_date" DATE NOT NULL,
    "end_date" DATE,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "patients_treatments_pk" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "session" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "session_key" TEXT NOT NULL,
    "user_id" UUID NOT NULL,
    "valid_until" TIMESTAMP(6) NOT NULL,
    CONSTRAINT "session_pk" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "treatment" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" VARCHAR(30) NOT NULL,
    "description" TEXT,
    CONSTRAINT "treatment_pk" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "user" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "is_site_admin" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "user_pk" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "user_patient" (
    "user_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL
);
-- CreateTable
CREATE TABLE "growth_data" (
    "age" INTEGER NOT NULL,
    "percentile" INTEGER NOT NULL,
    "value" REAL NOT NULL,
    "sex" "sex" NOT NULL,
    "ethnicity" VARCHAR NOT NULL
);
-- CreateTable
CREATE TABLE "google_auth" (
    "user_id" UUID NOT NULL,
    "google_identity" TEXT NOT NULL,
    CONSTRAINT "google_auth_pk" PRIMARY KEY ("user_id")
);
-- CreateTable
CREATE TABLE "patient_k" (
    "patient_id" UUID NOT NULL,
    "k_type" "ktype" NOT NULL,
    "od" REAL,
    "os" REAL
);
-- CreateIndex
CREATE UNIQUE INDEX "country_unique" ON "country"("name");
-- CreateIndex
CREATE UNIQUE INDEX "country_unique_1" ON "country"("code");
-- CreateIndex
CREATE UNIQUE INDEX "hospital_unique" ON "hospital"("name");
-- CreateIndex
CREATE UNIQUE INDEX "hospital_unique_1" ON "hospital"("code");
-- CreateIndex
CREATE UNIQUE INDEX "instrument_unique" ON "instrument"("name");
-- CreateIndex
CREATE UNIQUE INDEX "password_auth_unique" ON "password_auth"("username");
-- CreateIndex
CREATE UNIQUE INDEX "session_unique" ON "session"("session_key");
-- CreateIndex
CREATE UNIQUE INDEX "treatment_unique" ON "treatment"("name");
-- CreateIndex
CREATE UNIQUE INDEX "user_patient_unique" ON "user_patient"("user_id", "patient_id");
-- CreateIndex
CREATE UNIQUE INDEX "growth_data_unique" ON "growth_data"("age", "percentile", "sex", "ethnicity");
-- CreateIndex
CREATE UNIQUE INDEX "google_auth_unique" ON "google_auth"("google_identity");
-- CreateIndex
CREATE UNIQUE INDEX "patient_k_unique" ON "patient_k"("patient_id", "k_type");
-- AddForeignKey
ALTER TABLE "healthcare_professional"
ADD CONSTRAINT "healthcare_professional_country_fk" FOREIGN KEY ("country_id") REFERENCES "country"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "healthcare_professional"
ADD CONSTRAINT "healthcare_professional_ethnicity_fk" FOREIGN KEY ("default_ethnicity_id") REFERENCES "ethnicity"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "healthcare_professional"
ADD CONSTRAINT "healthcare_professional_hospital_fk" FOREIGN KEY ("hospital_id") REFERENCES "hospital"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "healthcare_professional"
ADD CONSTRAINT "healthcare_professional_instrument_fk" FOREIGN KEY ("default_instrument_id") REFERENCES "instrument"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "healthcare_professional"
ADD CONSTRAINT "healthcare_professional_user_fk" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "hospital"
ADD CONSTRAINT "hospital_country_fk" FOREIGN KEY ("country_id") REFERENCES "country"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "measurement"
ADD CONSTRAINT "measurement_instrument_fk" FOREIGN KEY ("instrument_id") REFERENCES "instrument"("id") ON DELETE
SET NULL ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "measurement"
ADD CONSTRAINT "measurement_patient_fk" FOREIGN KEY ("patient_id") REFERENCES "patient"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "measurement"
ADD CONSTRAINT "measurement_user_fk" FOREIGN KEY ("creator_id") REFERENCES "user"("id") ON DELETE
SET NULL ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "normal_user"
ADD CONSTRAINT "normal_user_user_fk" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "password_auth"
ADD CONSTRAINT "password_auth_user_fk" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "patient"
ADD CONSTRAINT "patient_ethnicity_fk" FOREIGN KEY ("ethnicity_id") REFERENCES "ethnicity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "patient"
ADD CONSTRAINT "patient_hospital_fk" FOREIGN KEY ("hospital_id") REFERENCES "hospital"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "patient"
ADD CONSTRAINT "patient_user_fk" FOREIGN KEY ("creator_id") REFERENCES "user"("id") ON DELETE
SET NULL ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "patient_treatment"
ADD CONSTRAINT "patient_treatment_patient_fk" FOREIGN KEY ("patient_id") REFERENCES "patient"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "patient_treatment"
ADD CONSTRAINT "patient_treatment_treatment_fk" FOREIGN KEY ("treatment_id") REFERENCES "treatment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "session"
ADD CONSTRAINT "session_user_fk" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "user_patient"
ADD CONSTRAINT "user_patient_patient_fk" FOREIGN KEY ("patient_id") REFERENCES "patient"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "user_patient"
ADD CONSTRAINT "user_patient_user_fk" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "google_auth"
ADD CONSTRAINT "google_auth_user_fk" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "patient_k"
ADD CONSTRAINT "patient_k_patient_fk" FOREIGN KEY ("patient_id") REFERENCES "patient"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- Manual constraint for patient_treatment table
ALTER TABLE "patient_treatment"
ADD CONSTRAINT "patient_treatment_check" CHECK (
        (
            (end_date >= start_date)
            OR (end_date IS NULL)
        )
    );