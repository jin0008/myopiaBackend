-- CreateEnum
CREATE TYPE "audit_status" AS ENUM ('SUCCESS', 'FAILURE', 'REVERTED');

-- AlterEnum
ALTER TYPE "audit_action" ADD VALUE 'READ';
ALTER TYPE "audit_action" ADD VALUE 'EXPORT';

-- AlterTable
ALTER TABLE "audit_log"
  ALTER COLUMN "record_id" DROP NOT NULL,
  ALTER COLUMN "created_at" TYPE TIMESTAMPTZ(6),
  ADD COLUMN "status" "audit_status" NOT NULL DEFAULT 'SUCCESS',
  ADD COLUMN "actor_name" TEXT,
  ADD COLUMN "actor_role" TEXT,
  ADD COLUMN "actor_hospital_id" UUID,
  ADD COLUMN "hospital_id" UUID,
  ADD COLUMN "ip_address" TEXT,
  ADD COLUMN "user_agent" TEXT,
  ADD COLUMN "changed_fields" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "error_message" TEXT;

-- CreateIndex
CREATE INDEX "audit_log_patient_created_idx" ON "audit_log" ("patient_id", "created_at" DESC);
CREATE INDEX "audit_log_actor_created_idx" ON "audit_log" ("actor_id", "created_at" DESC);
CREATE INDEX "audit_log_hospital_created_idx" ON "audit_log" ("hospital_id", "created_at" DESC);
CREATE INDEX "audit_log_created_idx" ON "audit_log" ("created_at" DESC);
