import express from "express";
import prisma from "../lib/prisma";
import zod from "zod";
import { loginRequired } from "../lib/middlewares";

const router = express.Router();
router.use(loginRequired);

router.get("/patient", async (req, res) => {
  const data = await prisma.patient.findMany({
    where: {
      user_patient: {
        some: {
          user_id: req.authSession?.user_id,
        },
      },
    },
  });
  res.json(data);
});

const postPatientSchema = zod.object({
  hospital_id: zod.string().uuid(),
  registration_number: zod.string(),
  date_of_birth: zod.string().date(),
});
router.post("/patient", async (req, res) => {
  let data;
  try {
    data = postPatientSchema.parse(req.body);
  } catch {
    res.sendStatus(400);
    return;
  }

  const patient = await prisma.patient.findFirst({
    where: {
      hospital_id: data.hospital_id,
      registration_number: data.registration_number,
      date_of_birth: data.date_of_birth,
    },
  });

  if (patient == null) {
    res.sendStatus(400);
    return;
  }

  await prisma.user_patient.create({
    data: {
      user_id: req.authSession?.user_id,
      patient_id: patient.id,
    },
  });
  res.sendStatus(201);
});

router.delete("/patient/:patientId", async (req, res) => {
  await prisma.user_patient.deleteMany({
    where: {
      user_id: req.authSession?.user_id,
      patient_id: req.params.patientId,
    },
  });
  res.sendStatus(200);
});

export default router;
