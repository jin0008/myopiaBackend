-- Add 'unknown' value to myopia_status enum so the mobile app can
-- record "잘 모름" / "Unknown" without storing a NULL row.
--
-- Postgres does not support adding enum values inside a transaction
-- block by default, but ALTER TYPE ... ADD VALUE IF NOT EXISTS works
-- standalone. Prisma migrate applies this without wrapping in BEGIN/
-- COMMIT for ALTER TYPE statements.

ALTER TYPE "myopia_status" ADD VALUE IF NOT EXISTS 'unknown';
