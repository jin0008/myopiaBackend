/**
 * Deletes audit_log rows older than the configured retention period.
 *
 * Run periodically (e.g. a daily systemd timer / cron job on the server):
 *   node dist/scripts/purge-old-audit-logs.js
 *
 * Retention is configurable via the AUDIT_LOG_RETENTION_DAYS env var and
 * defaults to 730 days (2 years), the minimum recommended for access logs to
 * sensitive personal data. Increase it to keep logs longer; never set it below
 * the legally required retention.
 */
import "dotenv/config";
import prisma from "../lib/prisma";

const DEFAULT_RETENTION_DAYS = 730;
const MS_PER_DAY = 1000 * 60 * 60 * 24;

async function main() {
  const days = Number(
    process.env.AUDIT_LOG_RETENTION_DAYS ?? DEFAULT_RETENTION_DAYS,
  );
  if (!Number.isFinite(days) || days <= 0) {
    throw new Error(
      `Invalid AUDIT_LOG_RETENTION_DAYS: ${process.env.AUDIT_LOG_RETENTION_DAYS}`,
    );
  }

  const cutoff = new Date(Date.now() - days * MS_PER_DAY);
  const { count } = await prisma.audit_log.deleteMany({
    where: { created_at: { lt: cutoff } },
  });

  console.log(
    `[purge-old-audit-logs] deleted ${count} row(s) older than ${cutoff.toISOString()} (retention ${days} days)`,
  );
}

main()
  .catch((err) => {
    console.error("[purge-old-audit-logs] failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
