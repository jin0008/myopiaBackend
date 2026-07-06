-- CreateEnum
CREATE TYPE "refraction_method" AS ENUM ('Auto', 'MR', 'CR');

-- CreateTable
CREATE TABLE "study" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "code" VARCHAR,
    "description" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "study_pk" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "study_hospital" (
    "study_id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "study_hospital_pk" PRIMARY KEY ("study_id","hospital_id")
);

-- CreateTable
CREATE TABLE "study_enrollment" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "study_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "enrolled_by" UUID,
    "enrolled_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL DEFAULT 'active',

    CONSTRAINT "study_enrollment_pk" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "study_visit" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "enrollment_id" UUID NOT NULL,
    "visit_date" DATE NOT NULL,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "va_od" REAL,
    "va_os" REAL,
    "bcva_od" REAL,
    "bcva_os" REAL,
    "refraction_method" "refraction_method",
    "ref_od_sph" REAL,
    "ref_od_cyl" REAL,
    "ref_od_axis" INTEGER,
    "ref_os_sph" REAL,
    "ref_os_cyl" REAL,
    "ref_os_axis" INTEGER,
    "slitlamp_od_normal" BOOLEAN,
    "slitlamp_od_finding" TEXT,
    "slitlamp_os_normal" BOOLEAN,
    "slitlamp_os_finding" TEXT,
    "iop_od" REAL,
    "iop_os" REAL,
    "accom_od" REAL,
    "accom_os" REAL,
    "measurement_id" UUID,
    "concomitant_meds" TEXT,
    "adverse_event" TEXT,

    CONSTRAINT "study_visit_pk" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "study_unique" ON "study"("name");

-- CreateIndex
CREATE INDEX "idx_study_hospital_hospital" ON "study_hospital"("hospital_id");

-- CreateIndex
CREATE INDEX "idx_study_enrollment_patient" ON "study_enrollment"("patient_id");

-- CreateIndex
CREATE UNIQUE INDEX "study_enrollment_unique" ON "study_enrollment"("study_id", "patient_id");

-- CreateIndex
CREATE INDEX "idx_study_visit_enrollment" ON "study_visit"("enrollment_id", "visit_date" DESC);

-- AddForeignKey
ALTER TABLE "study_hospital" ADD CONSTRAINT "study_hospital_study_fk" FOREIGN KEY ("study_id") REFERENCES "study"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "study_hospital" ADD CONSTRAINT "study_hospital_hospital_fk" FOREIGN KEY ("hospital_id") REFERENCES "hospital"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "study_enrollment" ADD CONSTRAINT "study_enrollment_study_fk" FOREIGN KEY ("study_id") REFERENCES "study"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "study_enrollment" ADD CONSTRAINT "study_enrollment_patient_fk" FOREIGN KEY ("patient_id") REFERENCES "patient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "study_enrollment" ADD CONSTRAINT "study_enrollment_user_fk" FOREIGN KEY ("enrolled_by") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "study_visit" ADD CONSTRAINT "study_visit_enrollment_fk" FOREIGN KEY ("enrollment_id") REFERENCES "study_enrollment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "study_visit" ADD CONSTRAINT "study_visit_user_fk" FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "study_visit" ADD CONSTRAINT "study_visit_measurement_fk" FOREIGN KEY ("measurement_id") REFERENCES "measurement"("id") ON DELETE SET NULL ON UPDATE CASCADE;

