/*
  Warnings:

  - Made the column `registration_number_hash` on table `patient` required. This step will fail if there are existing NULL values in that column.

*/
-- AlterTable
ALTER TABLE "patient" ALTER COLUMN "registration_number_hash" SET NOT NULL;
