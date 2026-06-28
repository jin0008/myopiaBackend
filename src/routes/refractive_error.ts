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
import { checkRefractiveErrorAlerts } from "../services/notification";

const router = express.Router();

const postBodyType = zod.object({
  patient_id: zod.string().uuid(),
  date: zod.string().date(),
  method_id: zod.number().int(),
  od_sph: zod.number(),
  od_cyl: zod.number(),
  os_sph: zod.number(),
  os_cyl: zod.number(),
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
      const created = await prisma.refractive_error.create({
        data: {
          patient_id: data.patient_id,
          date: new Date(data.date),
          method_id: data.method_id,
          od_sph: data.od_sph,
          od_cyl: data.od_cyl,
          os_sph: data.os_sph,
          os_cyl: data.os_cyl,
          creator_id: req.authSession!.user_id,
        },
      });

      await writeAuditLog({
        ...ctx,
        tableName: "refractive_error",
        recordId: created.id,
        action: "CREATE",
        hospitalId,
        patientId: created.patient_id,
        newValue: created,
      });

      checkRefractiveErrorAlerts(created).catch(console.error);

      res.sendStatus(200);
    } catch (err) {
      await writeAuditFailure(
        {
          ...ctx,
          tableName: "refractive_error",
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
  "/:refractiveErrorId",
  approvedProfessionalRequired,
  validateRequestBody(patchBodyType),
  async (req, res) => {
    const data = req.body as zod.infer<typeof patchBodyType>;
    const refractiveErrorId = String(req.params.refractiveErrorId);
    const hospitalId = req.healthcare_professional!.hospital_id;

    const authorized = await prisma.refractive_error
      .findUnique({
        where: {
          id: refractiveErrorId,
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
        (refractiveError) =>
          refractiveError?.patient?.hospital_id === hospitalId,
      )
      .catch(() => false);

    if (!authorized) {
      res.sendStatus(403);
      return;
    }

    const ctx = auditContextFromRequest(req);
    try {
      const updated = await prisma.$transaction(async (tx) => {
        const oldValue = await tx.refractive_error.findUnique({
          where: { id: refractiveErrorId },
        });
        const updated = await tx.refractive_error.update({
          where: {
            id: refractiveErrorId,
          },
          data: {
            ...data,
            date: new Date(data.date),
          },
        });
        await writeAuditLog({
          ...ctx,
          tableName: "refractive_error",
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

      checkRefractiveErrorAlerts(updated).catch(console.error);

      res.sendStatus(200);
    } catch (err) {
      await writeAuditFailure(
        {
          ...ctx,
          tableName: "refractive_error",
          recordId: refractiveErrorId,
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

router.delete("/:id", approvedProfessionalRequired, async (req, res) => {
  const refractiveErrorId = String(req.params.id);
  const hospitalId = req.healthcare_professional!.hospital_id;

  const authorized = await prisma.refractive_error
    .findUnique({
      where: {
        id: refractiveErrorId,
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
      (refractiveError) => refractiveError?.patient?.hospital_id === hospitalId,
    );

  if (!authorized) {
    res.sendStatus(403);
    return;
  }

  const ctx = auditContextFromRequest(req);
  await prisma
    .$transaction(async (tx) => {
      const oldValue = await tx.refractive_error.findUnique({
        where: { id: refractiveErrorId },
      });
      const deleted = await tx.refractive_error.delete({
        where: {
          id: refractiveErrorId,
        },
      });
      await writeAuditLog({
        ...ctx,
        tableName: "refractive_error",
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
          tableName: "refractive_error",
          recordId: refractiveErrorId,
          action: "DELETE",
          hospitalId,
        },
        err,
      );
      throw err;
    });
});

export default router;
