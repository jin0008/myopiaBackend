import express from "express";
import prisma from "../lib/prisma";
import zod from "zod";
import {
  approvedProfessionalRequired,
  loginRequired,
} from "../lib/middlewares";
import { Prisma } from "@prisma/client";

const router = express.Router();
router.use(loginRequired);

const postBodyType = zod.object({
  patient_id: zod.string().uuid(),
  date: zod.string().date(),
  instrument_id: zod.string().uuid(),
  od: zod.number().gte(15).lte(35),
  os: zod.number().gte(15).lte(35),
});
router.post("/", approvedProfessionalRequired, async (req, res) => {
  let data;
  try {
    data = postBodyType.parse(req.body);
  } catch {
    res.sendStatus(400);
    return;
  }
  const patient_hospital_id = await prisma.hospital
    .findFirst({
      where: {
        patient: {
          some: {
            id: data.patient_id,
          },
        },
      },

      select: {
        id: true,
      },
    })
    .then((result) => result?.id);

  const auth_hospital_id = req.healthcare_professional.hospital_id;

  if (patient_hospital_id !== auth_hospital_id) {
    res.sendStatus(403);
  } else {
    await prisma.measurement.create({
      data: {
        patient_id: data.patient_id,
        date: new Date(data.date),
        instrument_id: data.instrument_id,
        od: data.od,
        os: data.os,
        creator_id: req.authSession.user_id,
      },
    });
    res.sendStatus(200);
  }
});

router.delete(
  "/:measurementId",
  approvedProfessionalRequired,
  async (req, res, next) => {
    prisma.measurement
      .delete({
        where: {
          id: req.params.measurementId,
        },
      })
      .then(() => res.sendStatus(200))
      .catch((err: any) => {
        if (
          err instanceof Prisma.PrismaClientKnownRequestError &&
          err.code === "P2025"
        )
          res.sendStatus(404);
        else next(err);
      });
  }
);

export default router;
