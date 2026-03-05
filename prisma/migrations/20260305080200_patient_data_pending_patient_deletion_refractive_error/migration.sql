-- CreateEnum
CREATE TYPE "public"."activity_duration_category" AS ENUM ('zero_to_one', 'one_to_two', 'two_to_four', 'four_to_six', 'six_to_eight', 'eight_to_infinity');

-- CreateEnum
CREATE TYPE "public"."myopia_status" AS ENUM ('myopia', 'high_myopia', 'emmetropia', 'hyperopia');

-- DropForeignKey
ALTER TABLE "public"."measurement" DROP CONSTRAINT "measurement_instrument_fk";

-- AlterTable
ALTER TABLE "public"."measurement" ALTER COLUMN "creator_id" DROP NOT NULL;

-- CreateTable
CREATE TABLE "public"."patient_nearwork_activity" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "patient_id" UUID NOT NULL,
    "timestamp" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "category" "public"."activity_duration_category" NOT NULL,

    CONSTRAINT "patient_nearwork_activity_pk" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."patient_outdoor_activity" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "patient_id" UUID NOT NULL,
    "timestamp" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "category" "public"."activity_duration_category" NOT NULL,

    CONSTRAINT "patient_outdoor_activity_pk" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."patient_parental_myopia_status" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "parent_sex" "public"."sex" NOT NULL,
    "patient_id" UUID NOT NULL,
    "status" "public"."myopia_status" NOT NULL,
    "timestamp" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "patient_parental_myopia_status_pk" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."refractive_error" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "method_id" INTEGER NOT NULL,
    "od_sph" REAL,
    "od_cyl" REAL,
    "os_cyl" REAL,
    "os_sph" REAL,
    "date" DATE NOT NULL,
    "creator_id" UUID,
    "patient_id" UUID NOT NULL,

    CONSTRAINT "refractive_error_pk" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."refractive_error_method" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "refractive_error_method_pk" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "refractive_error_method_unique" ON "public"."refractive_error_method"("name" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "ethnicity_unique" ON "public"."ethnicity"("name" ASC);

-- AddForeignKey
ALTER TABLE "public"."measurement" ADD CONSTRAINT "measurement_instrument_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instrument"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."patient_nearwork_activity" ADD CONSTRAINT "patient_nearwork_activity_patient_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."patient_outdoor_activity" ADD CONSTRAINT "patient_outdoor_activity_patient_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."patient_parental_myopia_status" ADD CONSTRAINT "patient_parental_myopia_status_patient_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."refractive_error" ADD CONSTRAINT "refractive_error_patient_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."refractive_error" ADD CONSTRAINT "refractive_error_refactive_error_method_fk" FOREIGN KEY ("method_id") REFERENCES "public"."refractive_error_method"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."refractive_error" ADD CONSTRAINT "refractive_error_user_fk" FOREIGN KEY ("creator_id") REFERENCES "public"."user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

