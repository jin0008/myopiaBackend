import express from "express";
import prisma from "../lib/prisma";
import zod from "zod";
import { siteAdminRequired, validateRequestBody } from "../lib/middlewares";

// Study master-data management. Site admins create studies and assign which
// hospitals may participate (study_hospital). Following the convention of the
// other site-admin master-data routes (hospital, healthcare_professional),
// these endpoints are not audit-logged; patient-facing enrolment is.
const router = express.Router();
router.use(siteAdminRequired);

// List all studies with their participating hospitals and enrolled patient count.
router.get("/", async (req, res) => {
  const studies = await prisma.study.findMany({
    orderBy: { created_at: "desc" },
    include: {
      study_hospital: {
        select: {
          hospital: { select: { id: true, name: true, code: true } },
        },
      },
      _count: { select: { study_patient: true } },
    },
  });

  const payload = studies.map((study) => ({
    id: study.id,
    name: study.name,
    description: study.description,
    created_at: study.created_at,
    hospitals: study.study_hospital.map((sh) => sh.hospital),
    patientCount: study._count.study_patient,
  }));

  res.json(payload);
});

const studyBodyType = zod.object({
  name: zod.string().trim().min(1),
  description: zod.string().trim().min(1).nullable().optional(),
});

router.post("/", validateRequestBody(studyBodyType), async (req, res) => {
  const data = req.body as zod.infer<typeof studyBodyType>;
  const created = await prisma.study.create({
    data: {
      name: data.name,
      description: data.description ?? null,
    },
  });
  res.status(201).json(created);
});

const studyPatchType = studyBodyType.partial();

router.patch("/:id", validateRequestBody(studyPatchType), async (req, res) => {
  const data = req.body as zod.infer<typeof studyPatchType>;
  await prisma.study
    .update({
      where: { id: String(req.params.id) },
      data: {
        name: data.name,
        description: data.description,
      },
    })
    .then((updated) => res.json(updated))
    .catch(() => res.sendStatus(404));
});

router.delete("/:id", async (req, res) => {
  await prisma.study
    .delete({ where: { id: String(req.params.id) } })
    .then(() => res.sendStatus(200))
    .catch(() => res.sendStatus(404));
});

// Assign a hospital to a study (idempotent). Only assigned hospitals see the
// study button and may enrol their patients.
router.put("/:id/hospital/:hospitalId", async (req, res) => {
  const studyId = String(req.params.id);
  const hospitalId = String(req.params.hospitalId);

  const [study, hospital] = await Promise.all([
    prisma.study.findUnique({ where: { id: studyId }, select: { id: true } }),
    prisma.hospital.findUnique({
      where: { id: hospitalId },
      select: { id: true },
    }),
  ]);
  if (study == null || hospital == null) {
    res.sendStatus(404);
    return;
  }

  await prisma.study_hospital.upsert({
    where: { study_id_hospital_id: { study_id: studyId, hospital_id: hospitalId } },
    create: { study_id: studyId, hospital_id: hospitalId },
    update: {},
  });
  res.sendStatus(200);
});

// Remove a hospital's participation in a study.
router.delete("/:id/hospital/:hospitalId", async (req, res) => {
  await prisma.study_hospital
    .delete({
      where: {
        study_id_hospital_id: {
          study_id: String(req.params.id),
          hospital_id: String(req.params.hospitalId),
        },
      },
    })
    .then(() => res.sendStatus(200))
    .catch(() => res.sendStatus(404));
});

export default router;
