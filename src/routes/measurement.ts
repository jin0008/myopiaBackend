import express from "express";
import prisma from "../lib/prisma";
import zod from "zod";
import {
  approvedProfessionalRequired,
  loginRequired,
} from "../lib/middlewares";
import { od_os } from "@prisma/client";
import { PrismaClientKnownRequestError } from "@prisma/client/runtime/library";

const router = express.Router();
router.use(loginRequired);

router.get("/", approvedProfessionalRequired, async (req, res) => {
  const data = await prisma.hospital.findUnique({
    where: {
      id: req.healthcare_professional.hospital_id,
    },
    select: {
      patient: {
        include: {
          measurement: {
            include: {
              instrument: true,
            },
          },
        },
      },
    },
  });
  res.json(data?.patient);
});

router.get("/:measurementId", async (req, res) => {
  const data = await prisma.measurement.findFirst({
    where: {
      id: req.params.measurementId,
      patient: {
        OR: [
          {
            hospital_id: req.healthcare_professional.hospital_id,
          },
          {
            user_patient: {
              some: {
                user: {
                  id: req.authSession?.user_id,
                },
              },
            },
          },
        ],
      },
    },
  });
  if (data == null) {
    res.sendStatus(404);
    return;
  }
  res.json(data);
});

const postBodyType = zod.object({
  patient_id: zod.string().uuid(),
  date: zod.string().date(),
  instrument_id: zod.string().uuid(),
  eye: zod.nativeEnum(od_os),
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
        date: data.date,
        instrument_id: data.instrument_id,
        eye: data.eye,
        creator_id: req.authSession?.user_id,
      },
    });
    res.sendStatus(200);
  }
});

router.delete("/:measurementId", async (req, res, next) => {
  prisma.measurement
    .delete({
      where: {
        id: req.params.measurementId,
      },
    })
    .then(() => res.sendStatus(200))
    .catch((err) => {
      if (err instanceof PrismaClientKnownRequestError && err.code === "P2025")
        res.sendStatus(404);
      else next(err);
    });
});

export default router;
