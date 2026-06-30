import express from "express";
import zod from "zod";
import ExcelJS from "exceljs";
import { Prisma, audit_action, audit_status } from "@prisma/client";
import prisma from "../lib/prisma";
import {
  approvedProfessionalRequired,
  siteAdminRequired,
} from "../lib/middlewares";
import { isPatientInHospital } from "../lib/authorization";
import { auditContextFromRequest, writeAuditLog } from "../services/audit";

const router = express.Router();

const MAX_PAGE_SIZE = 500;
const MAX_EXPORT_ROWS = 100_000;

const filterSchema = zod.object({
  from: zod.string().date().optional(),
  to: zod.string().date().optional(),
  hospital_id: zod.string().uuid().optional(),
  actor_id: zod.string().uuid().optional(),
  patient_id: zod.string().uuid().optional(),
  table_name: zod.string().optional(),
  action: zod.nativeEnum(audit_action).optional(),
  status: zod.nativeEnum(audit_status).optional(),
});

/**
 * Builds the Prisma `where` clause for an audit query. The audit console is a
 * platform-wide site-admin feature, so by default it spans all hospitals; an
 * optional `hospital_id` filter narrows the view to a single institution.
 */
function buildWhere(
  filters: zod.infer<typeof filterSchema>,
): Prisma.audit_logWhereInput {
  const where: Prisma.audit_logWhereInput = {};

  if (filters.hospital_id) where.hospital_id = filters.hospital_id;
  if (filters.actor_id) where.actor_id = filters.actor_id;
  if (filters.patient_id) where.patient_id = filters.patient_id;
  if (filters.table_name) where.table_name = filters.table_name;
  if (filters.action) where.action = filters.action;
  if (filters.status) where.status = filters.status;

  if (filters.from || filters.to) {
    const createdAt: Prisma.DateTimeFilter = {};
    if (filters.from) createdAt.gte = new Date(filters.from);
    if (filters.to) {
      // `to` is inclusive: capture the whole day by going up to (but not
      // including) the start of the following day.
      const end = new Date(filters.to);
      end.setDate(end.getDate() + 1);
      createdAt.lt = end;
    }
    where.created_at = createdAt;
  }

  return where;
}

// GET /audit_log  — site-admin console list with filters + pagination.
router.get("/", siteAdminRequired, async (req, res) => {
  const parsed = filterSchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ message: "invalid filters" });
    return;
  }
  const where = buildWhere(parsed.data);

  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(
    MAX_PAGE_SIZE,
    Math.max(1, Number(req.query.pageSize) || 50),
  );

  const [total, rows] = await Promise.all([
    prisma.audit_log.count({ where }),
    prisma.audit_log.findMany({
      where,
      include: { actor: { select: { email: true } } },
      orderBy: { created_at: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ]);

  res.json({ page, pageSize, total, rows });
});

// GET /audit_log/export?format=csv|xlsx — download filtered logs.
router.get("/export", siteAdminRequired, async (req, res) => {
  const parsed = filterSchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ message: "invalid filters" });
    return;
  }
  const format = req.query.format === "xlsx" ? "xlsx" : "csv";
  const where = buildWhere(parsed.data);

  const rows = await prisma.audit_log.findMany({
    where,
    include: { actor: { select: { email: true } } },
    orderBy: { created_at: "desc" },
    take: MAX_EXPORT_ROWS,
  });

  // The export itself is an auditable, high-risk action.
  writeAuditLog({
    ...auditContextFromRequest(req),
    tableName: "audit_log",
    action: "EXPORT",
    hospitalId: parsed.data.hospital_id ?? null,
    patientId: parsed.data.patient_id ?? null,
    newValue: { format, filters: parsed.data, count: rows.length },
  }).catch(console.error);

  const stamp = new Date().toISOString().slice(0, 10);
  const filename = `audit_log_${stamp}.${format}`;

  if (format === "xlsx") {
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    await writeXlsx(res, rows);
  } else {
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(toCsv(rows));
  }
});

// GET /audit_log/patient/:patientId — per-patient history (any approved pro).
router.get(
  "/patient/:patientId",
  approvedProfessionalRequired,
  async (req, res) => {
    const patientId = String(req.params.patientId);

    const authorized = await isPatientInHospital(
      patientId,
      req.healthcare_professional!.hospital_id,
    );
    if (!authorized) {
      res.sendStatus(403);
      return;
    }

    const logs = await prisma.audit_log.findMany({
      where: { patient_id: patientId },
      include: { actor: { select: { email: true } } },
      orderBy: { created_at: "desc" },
    });
    res.json(logs);
  },
);

// ---- export serialization --------------------------------------------------

type AuditRow = Prisma.audit_logGetPayload<{
  include: { actor: { select: { email: true } } };
}>;

const EXPORT_COLUMNS: { header: string; value: (r: AuditRow) => string }[] = [
  { header: "발생시각", value: (r) => r.created_at.toISOString() },
  { header: "작업종류", value: (r) => r.action },
  { header: "상태", value: (r) => r.status },
  { header: "대상테이블", value: (r) => r.table_name },
  { header: "레코드ID", value: (r) => r.record_id ?? "" },
  { header: "작업자ID", value: (r) => r.actor_id ?? "" },
  { header: "작업자이름", value: (r) => r.actor_name ?? "" },
  { header: "작업자역할", value: (r) => r.actor_role ?? "" },
  { header: "작업자이메일", value: (r) => r.actor?.email ?? "" },
  { header: "소속기관ID", value: (r) => r.actor_hospital_id ?? "" },
  { header: "환자ID", value: (r) => r.patient_id ?? "" },
  { header: "데이터기관ID", value: (r) => r.hospital_id ?? "" },
  { header: "IP", value: (r) => r.ip_address ?? "" },
  { header: "기기정보", value: (r) => r.user_agent ?? "" },
  { header: "변경필드", value: (r) => r.changed_fields.join(", ") },
  { header: "이전값", value: (r) => jsonString(r.old_value) },
  { header: "변경값", value: (r) => jsonString(r.new_value) },
  { header: "오류메시지", value: (r) => r.error_message ?? "" },
];

function jsonString(value: Prisma.JsonValue): string {
  if (value == null) return "";
  return JSON.stringify(value);
}

function toCsv(rows: AuditRow[]): string {
  const escape = (s: string) =>
    /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  const header = EXPORT_COLUMNS.map((c) => escape(c.header)).join(",");
  const body = rows.map((r) =>
    EXPORT_COLUMNS.map((c) => escape(c.value(r))).join(","),
  );
  // Prepend a UTF-8 BOM so Excel opens Korean text without mojibake.
  return "﻿" + [header, ...body].join("\r\n");
}

async function writeXlsx(
  res: express.Response,
  rows: AuditRow[],
): Promise<void> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("audit_log");
  sheet.addRow(EXPORT_COLUMNS.map((c) => c.header));
  sheet.getRow(1).font = { bold: true };
  for (const r of rows) {
    sheet.addRow(EXPORT_COLUMNS.map((c) => c.value(r)));
  }
  await workbook.xlsx.write(res);
  res.end();
}

export default router;
