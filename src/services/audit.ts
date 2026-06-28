import type express from "express";
import prisma from "../lib/prisma";
import { Prisma, audit_action, audit_status } from "@prisma/client";

/**
 * Identifying context about *who* performed an action and *from where*.
 * Captured once per request via {@link auditContextFromRequest} and spread into
 * every {@link writeAuditLog} call so the log row is a self-contained,
 * point-in-time snapshot (the actor's name/role/hospital are stored as they
 * were at the time, not joined live — required for audit immutability).
 */
export interface AuditActorContext {
  actorId?: string | null;
  actorName?: string | null;
  actorRole?: string | null;
  actorHospitalId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}

export interface WriteAuditLogParams extends AuditActorContext {
  tableName: string;
  /** Null for actions that don't target a single row (e.g. EXPORT of a list). */
  recordId?: string | null;
  action: audit_action;
  status?: audit_status;
  /** The hospital that owns the data being touched. */
  hospitalId?: string | null;
  patientId?: string | null;
  oldValue?: unknown;
  newValue?: unknown;
  /** Names of the fields that actually changed (UPDATE only). */
  changedFields?: string[];
  errorMessage?: string | null;
  /**
   * Optional transaction client. When the audit write needs to be atomic with
   * the data change, pass the `tx` handed out by `prisma.$transaction`.
   */
  client?: Prisma.TransactionClient;
}

/**
 * Builds the actor/location context for an audit row from the incoming request.
 * Relies on the auth middlewares having populated `req.authSession` and (for
 * professional routes) `req.healthcare_professional`.
 */
export function auditContextFromRequest(
  req: express.Request,
): AuditActorContext {
  const hp = req.healthcare_professional;
  return {
    actorId: req.authSession?.user_id ?? null,
    actorName: hp?.name ?? null,
    actorRole: hp?.role ?? null,
    actorHospitalId: hp?.hospital_id ?? null,
    ip: clientIp(req),
    userAgent: req.get("user-agent") ?? null,
  };
}

/** Best-effort client IP, honouring a single proxy hop via X-Forwarded-For. */
function clientIp(req: express.Request): string | null {
  const forwarded = req.get("x-forwarded-for");
  if (forwarded) {
    // X-Forwarded-For may be a comma-separated list; the client is the first.
    return forwarded.split(",")[0].trim();
  }
  return req.ip ?? req.socket?.remoteAddress ?? null;
}

/**
 * Computes the names of fields whose value changed between two record
 * snapshots. Used to populate `changed_fields` for UPDATE audit rows.
 */
export function diffFields(
  oldValue: Record<string, unknown> | null | undefined,
  newValue: Record<string, unknown> | null | undefined,
): string[] {
  if (oldValue == null || newValue == null) return [];
  const keys = new Set([...Object.keys(oldValue), ...Object.keys(newValue)]);
  const changed: string[] = [];
  for (const key of keys) {
    if (!sameValue(oldValue[key], newValue[key])) {
      changed.push(key);
    }
  }
  return changed;
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a instanceof Date && b instanceof Date) {
    return a.getTime() === b.getTime();
  }
  // Fall back to structural comparison for nested objects/arrays.
  return JSON.stringify(normalize(a)) === JSON.stringify(normalize(b));
}

function normalize(value: unknown): unknown {
  return value instanceof Date ? value.toISOString() : value;
}

export async function writeAuditLog({
  tableName,
  recordId,
  action,
  status,
  actorId,
  actorName,
  actorRole,
  actorHospitalId,
  hospitalId,
  patientId,
  ip,
  userAgent,
  oldValue,
  newValue,
  changedFields,
  errorMessage,
  client,
}: WriteAuditLogParams) {
  const db = client ?? prisma;
  return db.audit_log.create({
    data: {
      table_name: tableName,
      record_id: recordId ?? null,
      action,
      status: status ?? "SUCCESS",
      actor_id: actorId ?? null,
      actor_name: actorName ?? null,
      actor_role: actorRole ?? null,
      actor_hospital_id: actorHospitalId ?? null,
      hospital_id: hospitalId ?? null,
      patient_id: patientId ?? null,
      ip_address: ip ?? null,
      user_agent: userAgent ?? null,
      changed_fields:
        changedFields ??
        (action === "UPDATE"
          ? diffFields(
              oldValue as Record<string, unknown>,
              newValue as Record<string, unknown>,
            )
          : []),
      old_value: (oldValue ?? Prisma.JsonNull) as Prisma.InputJsonValue,
      new_value: (newValue ?? Prisma.JsonNull) as Prisma.InputJsonValue,
      error_message: errorMessage ?? null,
    },
  });
}

/**
 * Writes a best-effort FAILURE audit row outside of any (already rolled-back)
 * transaction. Used when a data change throws so the attempt is still recorded.
 * Never throws — audit failures must not mask the original error.
 */
export async function writeAuditFailure(
  params: Omit<WriteAuditLogParams, "status" | "client">,
  error: unknown,
): Promise<void> {
  try {
    await writeAuditLog({
      ...params,
      status: "FAILURE",
      errorMessage: error instanceof Error ? error.message : String(error),
    });
  } catch (auditError) {
    console.error("Failed to write FAILURE audit log:", auditError);
  }
}
