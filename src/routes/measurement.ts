import express from "express";
import prisma from "../lib/prisma";
import zod from "zod";
import {
  approvedProfessionalRequired,
  validateRequestBody,
} from "../lib/middlewares";
import { PrismaClientKnownRequestError } from "@prisma/client/runtime/library";
import { isPatientInHospital } from "../lib/authorization";
import { writeAuditLog } from "../services/audit";
import { checkMeasurementThreshold } from "../services/notification";

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
    const authorized = await isPatientInHospital(
      data.patient_id,
      req.healthcare_professional!.hospital_id,
    );
    if (!authorized) {
      res.sendStatus(403);
      return;
    }
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
      tableName: "measurement",
      recordId: created.id,
      action: "CREATE",
      actorId: req.authSession!.user_id,
      patientId: created.patient_id,
      newValue: created,
    });

    checkMeasurementThreshold(created).catch(console.error);

    res.sendStatus(200);
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
      .then(
        (measurement) =>
          measurement?.patient.hospital_id ===
          req.healthcare_professional!.hospital_id,
      )
      .catch(() => false);

    if (!authorized) {
      res.sendStatus(403);
      return;
    }

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
        tableName: "measurement",
        recordId: updated.id,
        action: "UPDATE",
        actorId: req.authSession!.user_id,
        patientId: updated.patient_id,
        oldValue,
        newValue: updated,
        client: tx,
      });
      return updated;
    });

    checkMeasurementThreshold(updated).catch(console.error);

    res.sendStatus(200);
  },
);

router.delete(
  "/:measurementId",
  approvedProfessionalRequired,
  async (req, res) => {
    const measurementId = String(req.params.measurementId);

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
      .then(
        (measurement) =>
          measurement?.patient?.hospital_id ===
          req.healthcare_professional!.hospital_id,
      );

    if (!authorized) {
      res.sendStatus(403);
      return;
    }

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
          tableName: "measurement",
          recordId: deleted.id,
          action: "DELETE",
          actorId: req.authSession!.user_id,
          patientId: deleted.patient_id,
          oldValue,
          client: tx,
        });
      })
      .then(() => res.sendStatus(200))
      .catch((err) => {
        if (
          err instanceof PrismaClientKnownRequestError &&
          err.code === "P2025"
        ) {
          res.sendStatus(404);
          return;
        }
        throw err;
      });
  },
);

export default router;
