/*
  Warnings:

  - You are about to drop the column `category` on the `patient_nearwork_activity` table. All the data in the column will be lost.
  - You are about to drop the column `category` on the `patient_outdoor_activity` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "patient_nearwork_activity" DROP COLUMN "category",
ADD COLUMN     "hours" INTEGER;

-- AlterTable
ALTER TABLE "patient_outdoor_activity" DROP COLUMN "category",
ADD COLUMN     "hours" INTEGER;

-- AlterTable
ALTER TABLE "user" ADD COLUMN     "email" TEXT,
ADD COLUMN     "receive_email_updates" BOOLEAN NOT NULL DEFAULT false;

-- DropEnum
DROP TYPE "activity_duration_category";
