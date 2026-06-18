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
    const authorized = await isPatientInHospital(
      data.patient_id,
      req.healthcare_professional!.hospital_id,
    );
    if (!authorized) {
      res.sendStatus(403);
      return;
    }
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
      tableName: "refractive_error",
      recordId: created.id,
      action: "CREATE",
      actorId: req.authSession!.user_id,
      patientId: created.patient_id,
      newValue: created,
    });

    res.sendStatus(200);
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
          refractiveError?.patient?.hospital_id ===
          req.healthcare_professional!.hospital_id,
      )
      .catch(() => false);

    if (!authorized) {
      res.sendStatus(403);
      return;
    }

    await prisma.$transaction(async (tx) => {
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
        tableName: "refractive_error",
        recordId: updated.id,
        action: "UPDATE",
        actorId: req.authSession!.user_id,
        patientId: updated.patient_id,
        oldValue,
        newValue: updated,
        client: tx,
      });
    });
    res.sendStatus(200);
  },
);

router.delete("/:id", approvedProfessionalRequired, async (req, res) => {
  const refractiveErrorId = String(req.params.id);

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
        refractiveError?.patient?.hospital_id ===
        req.healthcare_professional!.hospital_id,
    );

  if (!authorized) {
    res.sendStatus(403);
    return;
  }

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
        tableName: "refractive_error",
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
});

export default router;
