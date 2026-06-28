import express from "express";
import prisma from "../lib/prisma";
import zod from "zod";
import {
  approvedProfessionalRequired,
  validateRequestBody,
} from "../lib/middlewares";
import { PrismaClientKnownRequestError } from "@prisma/client/runtime/library";
import { isPatientInHospital } from "../lib/authorization";
import {
  auditContextFromRequest,
  writeAuditFailure,
  writeAuditLog,
} from "../services/audit";
import { checkMeasurementAlerts } from "../services/notification";

const router = express.Router();

const postBodyType = zod.object({
  patient_id: zod.string().uuid(),
  date: zod.string().date(),
  instrument_id: zod.string().uuid(),
  od: zod.number().gte(15).lte(35),
  os: zod.number().gte(15).lte(35),
});
router.post(
  "/",
  validateRequestBody(postBodyType),
  approvedProfessionalRequired,
  async (req, res) => {
    const data = req.body as zod.infer<typeof postBodyType>;
    const hospitalId = req.healthcare_professional!.hospital_id;
    const authorized = await isPatientInHospital(data.patient_id, hospitalId);
    if (!authorized) {
      res.sendStatus(403);
      return;
    }
    const ctx = auditContextFromRequest(req);
    try {
      const created = await prisma.measurement.create({
        data: {
          patient_id: data.patient_id,
          date: new Date(data.date),
          instrument_id: data.instrument_id,
          od: data.od,
          os: data.os,
          creator_id: req.authSession!.user_id,
        },
      });

      await writeAuditLog({
        ...ctx,
        tableName: "measurement",
        recordId: created.id,
        action: "CREATE",
        hospitalId,
        patientId: created.patient_id,
        newValue: created,
      });

      checkMeasurementAlerts(created).catch(console.error);

      res.sendStatus(200);
    } catch (err) {
      await writeAuditFailure(
        {
          ...ctx,
          tableName: "measurement",
          action: "CREATE",
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

const patchBodyType = postBodyType.omit({ patient_id: true });

router.patch(
  "/:measurementId",
  approvedProfessionalRequired,
  validateRequestBody(patchBodyType),
  async (req, res) => {
    const data = req.body as zod.infer<typeof patchBodyType>;
    const measurementId = String(req.params.measurementId);
    const hospitalId = req.healthcare_professional!.hospital_id;
    const authorized = await prisma.measurement
      .findUnique({
        where: {
          id: measurementId,
        },
        select: {
          patient: {
            select: {
              hospital_id: true,
            },
          },
        },
      })
      .then((measurement) => measurement?.patient.hospital_id === hospitalId)
      .catch(() => false);

    if (!authorized) {
      res.sendStatus(403);
      return;
    }

    const ctx = auditContextFromRequest(req);
    try {
      const updated = await prisma.$transaction(async (tx) => {
        const oldValue = await tx.measurement.findUnique({
          where: { id: measurementId },
        });
        const updated = await tx.measurement.update({
          where: {
            id: measurementId,
          },
          data: {
            ...data,
            date: new Date(data.date),
          },
        });
        await writeAuditLog({
          ...ctx,
          tableName: "measurement",
          recordId: updated.id,
          action: "UPDATE",
          hospitalId,
          patientId: updated.patient_id,
          oldValue,
          newValue: updated,
          client: tx,
        });
        return updated;
      });

      checkMeasurementAlerts(updated).catch(console.error);

      res.sendStatus(200);
    } catch (err) {
      await writeAuditFailure(
        {
          ...ctx,
          tableName: "measurement",
          recordId: measurementId,
          action: "UPDATE",
          hospitalId,
          newValue: data,
        },
        err,
      );
      throw err;
    }
  },
);

router.delete(
  "/:measurementId",
  approvedProfessionalRequired,
  async (req, res) => {
    const measurementId = String(req.params.measurementId);
    const hospitalId = req.healthcare_professional!.hospital_id;

    const authorized = await prisma.measurement
      .findUnique({
        where: {
          id: measurementId,
        },
        select: {
          patient: {
            select: {
              hospital_id: true,
            },
          },
        },
      })
      .then((measurement) => measurement?.patient?.hospital_id === hospitalId);

    if (!authorized) {
      res.sendStatus(403);
      return;
    }

    const ctx = auditContextFromRequest(req);
    await prisma
      .$transaction(async (tx) => {
        const oldValue = await tx.measurement.findUnique({
          where: { id: measurementId },
        });
        const deleted = await tx.measurement.delete({
          where: {
            id: measurementId,
          },
        });
        await writeAuditLog({
          ...ctx,
          tableName: "measurement",
          recordId: deleted.id,
          action: "DELETE",
          hospitalId,
          patientId: deleted.patient_id,
          oldValue,
          client: tx,
        });
      })
      .then(() => res.sendStatus(200))
      .catch(async (err) => {
        if (
          err instanceof PrismaClientKnownRequestError &&
          err.code === "P2025"
        ) {
          res.sendStatus(404);
          return;
        }
        await writeAuditFailure(
          {
            ...ctx,
            tableName: "measurement",
            recordId: measurementId,
            action: "DELETE",
            hospitalId,
          },
          err,
        );
        throw err;
      });
  },
);

export default router;
