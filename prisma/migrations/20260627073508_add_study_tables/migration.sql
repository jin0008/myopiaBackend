-- CreateTable
CREATE TABLE "study" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "description" TEXT,
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
CREATE TABLE "study_patient" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "study_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "registered_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "registered_by" UUID,

    CONSTRAINT "study_patient_pk" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "study_unique" ON "study"("name");

-- CreateIndex
CREATE UNIQUE INDEX "study_patient_unique" ON "study_patient"("study_id", "patient_id");

-- AddForeignKey
ALTER TABLE "study_hospital" ADD CONSTRAINT "study_hospital_study_fk" FOREIGN KEY ("study_id") REFERENCES "study"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "study_hospital" ADD CONSTRAINT "study_hospital_hospital_fk" FOREIGN KEY ("hospital_id") REFERENCES "hospital"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "study_patient" ADD CONSTRAINT "study_patient_study_fk" FOREIGN KEY ("study_id") REFERENCES "study"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "study_patient" ADD CONSTRAINT "study_patient_patient_fk" FOREIGN KEY ("patient_id") REFERENCES "patient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "study_patient" ADD CONSTRAINT "study_patient_user_fk" FOREIGN KEY ("registered_by") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;
