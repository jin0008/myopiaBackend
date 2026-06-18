import prisma from "../lib/prisma";
import { Prisma, audit_action } from "@prisma/client";

export interface WriteAuditLogParams {
  tableName: string;
  recordId: string;
  action: audit_action;
  actorId?: string | null;
  patientId?: string | null;
  oldValue?: unknown;
  newValue?: unknown;
  /**
   * Optional transaction client. When the audit write needs to be atomic with
   * the data change, pass the `tx` handed out by `prisma.$transaction`.
   */
  client?: Prisma.TransactionClient;
}

export async function writeAuditLog({
  tableName,
  recordId,
  action,
  actorId,
  patientId,
  oldValue,
  newValue,
  client,
}: WriteAuditLogParams) {
  const db = client ?? prisma;
  return db.audit_log.create({
    data: {
      table_name: tableName,
      record_id: recordId,
      action,
      actor_id: actorId ?? null,
      patient_id: patientId ?? null,
      old_value: (oldValue ?? Prisma.JsonNull) as Prisma.InputJsonValue,
      new_value: (newValue ?? Prisma.JsonNull) as Prisma.InputJsonValue,
    },
  });
}
