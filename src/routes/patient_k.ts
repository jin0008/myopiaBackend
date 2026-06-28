import express from "express";
import prisma from "../lib/prisma";
import zod from "zod";
import {
  approvedProfessionalRequired,
  validateRequestBody,
} from "../lib/middlewares";
import { ktype } from "@prisma/client";
import { isPatientInHospital } from "../lib/authorization";
import {
  auditContextFromRequest,
  writeAuditFailure,
  writeAuditLog,
} from "../services/audit";

const router = express.Router();

const putBodyType = zod.object({
  patient_id: zod.string().uuid(),
  k_type: zod.nativeEnum(ktype),
  od: zod.number().nullable(),
  os: zod.number().nullable(),
});
router.put(
  "/",
  validateRequestBody(putBodyType),
  approvedProfessionalRequired,
  async (req, res) => {
    const data = req.body as zod.infer<typeof putBodyType>;
    const hospitalId = req.healthcare_professional!.hospital_id;
    const authorized = await isPatientInHospital(data.patient_id, hospitalId);
    if (!authorized) {
      res.sendStatus(403);
      return;
    }

    const ctx = auditContextFromRequest(req);
    try {
      await prisma.$transaction(async (tx) => {
        const oldValue = await tx.patient_k.findUnique({
          where: {
            patient_id_k_type: {
              patient_id: data.patient_id,
              k_type: data.k_type,
            },
          },
        });
        const upserted = await tx.patient_k.upsert({
          where: {
            patient_id_k_type: {
              patient_id: data.patient_id,
              k_type: data.k_type,
            },
          },
          update: {
            od: data.od,
            os: data.os,
          },
          create: {
            patient_id: data.patient_id,
            k_type: data.k_type,
            od: data.od,
            os: data.os,
          },
        });
        // patient_k has a composite key (patient_id, k_type) and no uuid id, so
        // the patient_id is used as the audit record_id.
        await writeAuditLog({
          ...ctx,
          tableName: "patient_k",
          recordId: upserted.patient_id,
          action: oldValue == null ? "CREATE" : "UPDATE",
          hospitalId,
          patientId: upserted.patient_id,
          oldValue,
          newValue: upserted,
          client: tx,
        });
      });
      res.sendStatus(200);
    } catch (err) {
      await writeAuditFailure(
        {
          ...ctx,
          tableName: "patient_k",
          recordId: data.patient_id,
          action: "UPDATE",
          hospitalId,
          patientId: data.patient_id,
          newValue: data,
        },
        err,
      );
      throw err;
    }
  },
);

export default router;
