import express from "express";
import prisma from "../lib/prisma";
import zod from "zod";
import {
  approvedProfessionalRequired,
  validateRequestBody,
} from "../lib/middlewares";
import { WrongArgumentsMessage } from "../lib/session";
import { isPatientInHospital } from "../lib/authorization";
import { writeAuditLog } from "../services/audit";

const router = express.Router();
router.use(approvedProfessionalRequired);

const postBodyType = zod.object({
  patient_id: zod.string().uuid(),
  treatment_id: zod.string().uuid(),
  start_date: zod.string().date(),
  end_date: zod.string().date().nullable(),
});

router.post("/", validateRequestBody(postBodyType), async (req, res) => {
  const data = req.body as zod.infer<typeof postBodyType>;
  const authorized = await isPatientInHospital(
    data.patient_id,
    req.healthcare_professional!.hospital_id,
  );
  if (!authorized) {
    res.sendStatus(403);
    return;
  }

  prisma.patient_treatment
    .create({
      data: {
        patient_id: data.patient_id,
        treatment_id: data.treatment_id,
        start_date: new Date(data.start_date),
        end_date: data.end_date == null ? null : new Date(data.end_date),
      },
    })
    .then(async (created) => {
      await writeAuditLog({
        tableName: "patient_treatment",
        recordId: created.id,
        action: "CREATE",
        actorId: req.authSession!.user_id,
        patientId: created.patient_id,
        newValue: created,
      });
      res.sendStatus(200);
    })
    .catch(() => res.status(400).json(WrongArgumentsMessage));
});

const patientTreatmentPatchType = zod
  .object({
    treatment_id: zod.string().uuid(),
    start_date: zod.string().date(),
    end_date: zod.string().date().nullable(),
  })
  .partial();

router.patch(
  "/:id",
  validateRequestBody(patientTreatmentPatchType),
  async (req, res) => {
    const patient_hospital_id = await prisma.patient_treatment
      .findUnique({
        where: {
          id: String(req.params.id),
        },
        select: {
          patient: {
            select: {
              hospital_id: true,
            },
          },
        },
      })
      .then((result) => result?.patient.hospital_id);
    const auth_hospital_id = req.healthcare_professional!.hospital_id;
    if (patient_hospital_id !== auth_hospital_id) {
      res.sendStatus(403);
      return;
    }

    const data = req.body;

    prisma
      .$transaction(async (tx) => {
        const oldValue = await tx.patient_treatment.findUnique({
          where: { id: String(req.params.id) },
        });
        const updated = await tx.patient_treatment.update({
          where: {
            id: String(req.params.id),
          },
          data: {
            treatment_id: data.treatment_id,
            start_date:
              data.start_date == null
                ? data.start_date
                : new Date(data.start_date),
            end_date:
              data.end_date == null ? data.end_date : new Date(data.end_date),
          },
        });
        await writeAuditLog({
          tableName: "patient_treatment",
          recordId: updated.id,
          action: "UPDATE",
          actorId: req.authSession!.user_id,
          patientId: updated.patient_id,
          oldValue,
          newValue: updated,
          client: tx,
        });
      })
      .then(() => res.sendStatus(200))
      .catch(() => res.status(400).json(WrongArgumentsMessage));
  },
);

router.delete("/:id", async (req, res) => {
  const patient_hospital_id = await prisma.patient_treatment
    .findUnique({
      where: {
        id: req.params.id,
      },
      select: {
        patient: {
          select: {
            hospital_id: true,
          },
        },
      },
    })
    .then((result) => result?.patient.hospital_id);
  const auth_hospital_id = req.healthcare_professional!.hospital_id;
  if (patient_hospital_id !== auth_hospital_id) {
    res.sendStatus(403);
    return;
  }

  await prisma.$transaction(async (tx) => {
    const oldValue = await tx.patient_treatment.findUnique({
      where: { id: req.params.id },
    });
    const deleted = await tx.patient_treatment.delete({
      where: {
        id: req.params.id,
      },
    });
    await writeAuditLog({
      tableName: "patient_treatment",
      recordId: deleted.id,
      action: "DELETE",
      actorId: req.authSession!.user_id,
      patientId: deleted.patient_id,
      oldValue,
      client: tx,
    });
  });
  res.sendStatus(200);
});

export default router;
