/*
  Warnings:

  - You are about to drop the column `date_of_birth` on the `patient` table. All the data in the column will be lost.
  - You are about to drop the column `registration_number` on the `patient` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[registration_number_hash,hospital_id]` on the table `patient` will be added. If there are existing duplicate values, this will fail.
  - Made the column `encrypted_date_of_birth` on table `patient` required. This step will fail if there are existing NULL values in that column.
  - Made the column `encrypted_registration_number` on table `patient` required. This step will fail if there are existing NULL values in that column.

*/
-- AlterTable
ALTER TABLE "patient" DROP COLUMN "date_of_birth",
DROP COLUMN "registration_number",
ADD COLUMN     "registration_number_hash" TEXT,
ALTER COLUMN "encrypted_date_of_birth" SET NOT NULL,
ALTER COLUMN "encrypted_registration_number" SET NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "patient_registration_number_hash_unique" ON "patient"("registration_number_hash", "hospital_id");
