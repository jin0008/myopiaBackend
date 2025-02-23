import express from "express";
import prisma from "../lib/prisma";
import zod from "zod";

import { getAuthSession, WrongArgumentsMessage } from "../lib/util";
import {
  approvedProfessionalRequired,
  loginRequired,
} from "../lib/middlewares";

const router = express.Router();
router.use(loginRequired);

const existingHospitalType = zod.object({
  id: zod.string(),
});

const newHospitalType = zod.object({
  name: zod.string().nonempty(),
  country_id: zod.string().uuid(),
});

const postType = zod.object({
  name: zod.string().nonempty(),
  country_id: zod.string().uuid(),
  hospital: zod.union([existingHospitalType, newHospitalType]),
  default_ethnicity_id: zod.string().uuid().nullable().optional(),
  default_instrument_id: zod.string().uuid().nullable().optional(),
});

router.post("/", async (req, res) => {
  const body = req.body;

  let data;

  try {
    data = postType.parse(body);
  } catch {
    res.status(400).json(WrongArgumentsMessage);
    return;
  }

  const existingHospital = existingHospitalType.safeParse(data.hospital);
  if (existingHospital.success) {
    await prisma.healthcare_professional.create({
      data: {
        user_id: req.authSession.user_id,
        name: data.name,
        country_id: data.country_id,
        hospital_id: existingHospital.data.id,
        default_ethnicity_id: data.default_ethnicity_id,
        default_instrument_id: data.default_instrument_id,
      },
    });
    res.sendStatus(201);
  }

  const newHospital = newHospitalType.safeParse(data.hospital);
  if (newHospital.success) {
    await prisma.healthcare_professional.create({
      data: {
        user: {
          connect: {
            id: req.authSession.user_id,
          },
        },
        name: data.name,
        country: {
          connect: {
            id: data.country_id,
          },
        },
        hospital: {
          create: {
            name: newHospital.data.name,
            country_id: newHospital.data.country_id,
          },
        },
        default_ethnicity:
          data.default_ethnicity_id == null
            ? undefined
            : {
                connect: {
                  id: data.default_ethnicity_id,
                },
              },
        default_instrument:
          data.default_instrument_id == null
            ? undefined
            : {
                connect: {
                  id: data.default_instrument_id,
                },
              },
      },
    });
    res.sendStatus(201);
  }
});

const putType = zod.object({
  default_ethnicity_id: zod.string().nullable().optional(),
  default_instrument_id: zod.string().nullable().optional(),
});

router.put("/", approvedProfessionalRequired, async (req, res) => {
  const authSession = await getAuthSession(req);

  const userId = authSession?.user_id;

  if (userId == null) {
    res.sendStatus(401);
    return;
  }

  const body = req.body;

  let data;
  try {
    data = putType.parse(body);
  } catch {
    res.sendStatus(400);
    return;
  }

  await prisma.healthcare_professional.update({
    where: {
      user_id: userId,
    },
    data: data,
  });

  res.sendStatus(200);
});

export default router;
