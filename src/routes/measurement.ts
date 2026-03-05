import express from "express";
import prisma from "../lib/prisma";
import zod from "zod";
import {
  approvedProfessionalRequired,
  validateRequestBody,
} from "../lib/middlewares";
import { PrismaClientKnownRequestError } from "@prisma/client/runtime/library";
import { isPatientInHospital } from "../lib/authorization";

const router = express.Router();

const postBodyType = zod.object({
  patient_id: zod.string().uuid(),
  date: zod.string().date(),
  instrument_id: zod.string().uuid(),
  od: zod.number().gte(15).lte(35),
  os: zod.number().gte(15).lte(35),
});
router.post(
  "/",
  validateRequestBody(postBodyType),
  approvedProfessionalRequired,
  async (req, res) => {
    const data = req.body as zod.infer<typeof postBodyType>;
    const authorized = await isPatientInHospital(
      data.patient_id,
      req.healthcare_professional!.hospital_id,
    );
    if (!authorized) {
      res.sendStatus(403);
      return;
    }
    await prisma.measurement.create({
      data: {
        patient_id: data.patient_id,
        date: new Date(data.date),
        instrument_id: data.instrument_id,
        od: data.od,
        os: data.os,
        creator_id: req.authSession!.user_id,
      },
    });
    res.sendStatus(200);
  },
);

router.delete(
  "/:measurementId",
  approvedProfessionalRequired,
  async (req, res) => {
    const measurementId = String(req.params.measurementId);

    const authorized = await prisma.measurement
      .findUnique({
        where: {
          id: measurementId,
        },
        select: {
          patient: {
            select: {
              hospital_id: true,
            },
          },
        },
      })
      .then(
        (measurement) =>
          measurement?.patient?.hospital_id ===
          req.healthcare_professional!.hospital_id,
      );

    if (!authorized) {
      res.sendStatus(403);
      return;
    }

    await prisma.measurement
      .delete({
        where: {
          id: req.params.measurementId as string,
        },
      })
      .then(() => res.sendStatus(200))
      .catch((err) => {
        if (
          err instanceof PrismaClientKnownRequestError &&
          err.code === "P2025"
        ) {
          res.sendStatus(404);
          return;
        }
        throw err;
      });
  },
);

export default router;
