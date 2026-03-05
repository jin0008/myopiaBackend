import express from "express";
import prisma from "../lib/prisma";
import zod from "zod";
import {
  approvedProfessionalRequired,
  validateRequestBody,
} from "../lib/middlewares";
import { ktype } from "@prisma/client";
import { isPatientInHospital } from "../lib/authorization";

const router = express.Router();

const putBodyType = zod.object({
  patient_id: zod.string().uuid(),
  k_type: zod.nativeEnum(ktype),
  od: zod.number().nullable(),
  os: zod.number().nullable(),
});
router.put(
  "/",
  validateRequestBody(putBodyType),
  approvedProfessionalRequired,
  async (req, res) => {
    const data = req.body as zod.infer<typeof putBodyType>;
    const authorized = await isPatientInHospital(
      data.patient_id,
      req.healthcare_professional!.hospital_id,
    );
    if (!authorized) {
      res.sendStatus(403);
      return;
    }

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
  },
);

export default router;
