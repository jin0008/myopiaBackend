import express from "express";
import prisma from "../lib/prisma";
import zod from "zod";
import { approvedProfessionalRequired } from "../lib/middlewares";
import { ktype } from "@prisma/client";

const router = express.Router();

const putBodyType = zod.object({
  patient_id: zod.string().uuid(),
  k_type: zod.nativeEnum(ktype),
  od: zod.number().nullable(),
  os: zod.number().nullable(),
});
router.put("/", approvedProfessionalRequired, async (req, res) => {
  let data;
  try {
    data = putBodyType.parse(req.body);
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

  const auth_hospital_id = req.healthcare_professional!.hospital_id;

  if (patient_hospital_id !== auth_hospital_id) {
    res.sendStatus(403);
  } else {
    await prisma.patient_k.upsert({
      where: {
        patient_id_k_type: {
          patient_id: data.patient_id,
          k_type: data.k_type,
        },
      },
      update: {
        od: data.od,
        os: data.os,
      },
      create: {
        patient_id: data.patient_id,
        k_type: data.k_type,
        od: data.od,
        os: data.os,
      },
    });
    res.sendStatus(200);
  }
});

export default router;
