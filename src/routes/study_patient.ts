import express from "express";
import prisma from "../lib/prisma";
import zod from "zod";
import {
  approvedProfessionalRequired,
  validateRequestBody,
} from "../lib/middlewares";
import { WrongArgumentsMessage } from "../lib/session";
import { isPatientInHospital } from "../lib/authorization";
import { PrismaClientKnownRequestError } from "@prisma/client/runtime/library";
import {
  auditContextFromRequest,
  writeAuditFailure,
  writeAuditLog,
} from "../services/audit";

// Patient enrolment into studies, used by approved professionals. A study only
// appears (and patients may only be enrolled into it) when the professional's
// own hospital has been assigned to that study by a site admin.
const router = express.Router();
router.use(approvedProfessionalRequired);

// Studies the caller's hospital is assigned to — the list shown in the
// "register to study" popup.
router.get("/available_studies", async (req, res) => {
  const hospitalId = req.healthcare_professional!.hospital_id;
  const studies = await prisma.study.findMany({
    where: { study_hospital: { some: { hospital_id: hospitalId } } },
    select: { id: true, name: true, description: true },
    orderBy: { name: "asc" },
  });
  res.json(studies);
});

// Studies a given patient is already enrolled in — used to render the activated
// follow-up button and the study name(s) for that patient.
router.get("/by_patient/:patientId", async (req, res) => {
  const hospitalId = req.healthcare_professional!.hospital_id;
  const patientId = String(req.params.patientId);
  const authorized = await isPatientInHospital(patientId, hospitalId);
  if (!authorized) {
    res.sendStatus(403);
    return;
  }

  const enrolments = await prisma.study_patient.findMany({
    where: { patient_id: patientId },
    select: {
      id: true,
      registered_at: true,
      study: { select: { id: true, name: true, description: true } },
    },
    orderBy: { registered_at: "desc" },
  });
  res.json(enrolments);
});

const enrolBodyType = zod.object({
  study_id: zod.string().uuid(),
  patient_id: zod.string().uuid(),
});

router.post("/", validateRequestBody(enrolBodyType), async (req, res) => {
  const data = req.body as zod.infer<typeof enrolBodyType>;
  const hospitalId = req.healthcare_professional!.hospital_id;

  // The patient must belong to the caller's hospital, and that hospital must be
  // a participant in the target study.
  const [patientInHospital, participation] = await Promise.all([
    isPatientInHospital(data.patient_id, hospitalId),
    prisma.study_hospital.findUnique({
      where: {
        study_id_hospital_id: {
          study_id: data.study_id,
          hospital_id: hospitalId,
        },
      },
    }),
  ]);
  if (!patientInHospital || participation == null) {
    res.sendStatus(403);
    return;
  }

  const ctx = auditContextFromRequest(req);
  try {
    const created = await prisma.study_patient.create({
      data: {
        study_id: data.study_id,
        patient_id: data.patient_id,
        registered_by: req.authSession!.user_id,
      },
    });
    await writeAuditLog({
      ...ctx,
      tableName: "study_patient",
      recordId: created.id,
      action: "CREATE",
      hospitalId,
      patientId: created.patient_id,
      newValue: created,
    });
    res.status(201).json(created);
  } catch (err) {
    // Patient is already enrolled in this study (unique [study_id, patient_id]).
    if (err instanceof PrismaClientKnownRequestError && err.code === "P2002") {
      res.sendStatus(409);
      return;
    }
    await writeAuditFailure(
      {
        ...ctx,
        tableName: "study_patient",
        action: "CREATE",
        hospitalId,
        patientId: data.patient_id,
        newValue: data,
      },
      err,
    );
    res.status(400).json(WrongArgumentsMessage);
  }
});

export default router;
