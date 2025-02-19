import express from "express";
import prisma from "../lib/prisma";
import zod from "zod";
import {
  approvedProfessionalRequired,
  loginRequired,
} from "../lib/middlewares";
import { sex } from "@prisma/client";
import { PrismaClientKnownRequestError } from "@prisma/client/runtime/library";

const router = express.Router();
router.use(loginRequired);

router.get("/", approvedProfessionalRequired, async (req, res) => {
  const data = await prisma.hospital.findUnique({
    where: {
      id: req.healthcare_professional.hospital_id,
    },
    include: {
      patient: true,
    },
  });
  res.json(data?.patient);
});

router.get("/:patientId", async (req, res) => {
  const data = await prisma.patient.findFirst({
    where: {
      id: req.params.patientId,
      hospital_id: req.healthcare_professional.hospital_id,
    },
  });
  if (data == null) {
    res.sendStatus(404);
    return;
  }
  res.json(data);
});

const postPatientSchema = zod.object({
  registration_number: zod.string(),
  date_of_birth: zod.string().date(),
  sex: zod.nativeEnum(sex),
  ethnicity_id: zod.string().uuid(),
  email: zod.string().email().optional(),
});
router.post("/", approvedProfessionalRequired, async (req, res) => {
  const data = postPatientSchema.parse(req.body);
  await prisma.patient.create({
    data: {
      ...data,
      hospital_id: req.healthcare_professional.hospital_id,
      creator_id: req.authSession?.user_id,
    },
  });
  res.sendStatus(201);
});

router.delete(
  "/:patientId",
  approvedProfessionalRequired,
  async (req, res, next) => {
    await prisma.patient
      .delete({
        where: {
          id: req.params.patientId,
          hospital_id: req.healthcare_professional.hospital_id,
        },
      })
      .catch((e) => {
        if (e instanceof PrismaClientKnownRequestError && e.code === "P2025") {
          res.sendStatus(404);
          return;
        }
        next(e);
      });

    res.sendStatus(200);
  }
);

export default router;
