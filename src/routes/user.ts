import express from "express";
import prisma from "../lib/prisma";
import zod from "zod";
import { loginRequired, validateRequestBody } from "../lib/middlewares";
import { linkAttemptLimiter } from "../lib/security";
import { CONSENT_VERSION } from "../lib/consent";
import { PrismaClientKnownRequestError } from "@prisma/client/runtime/library";
import { hashRegistrationNumber } from "../lib/hash";
import { decryptSymmetric } from "../services/encrpytion";

const router = express.Router();
router.use(loginRequired);

router.get("/patient", async (req, res) => {
  const data = await prisma.patient
    .findMany({
      where: {
        user_patient: {
          some: {
            user_id: req.authSession?.user_id,
          },
        },
      },
    })
    .then((patients) => {
      return Promise.all(
        patients.map(async (patient) => {
          return {
            ...patient,
            date_of_birth: await decryptSymmetric(
              patient.encrypted_date_of_birth,
            ),
            registration_number: await decryptSymmetric(
              patient.encrypted_registration_number,
            ),
          };
        }),
      );
    });
  res.json(data);
});

const postPatientSchema = zod.object({
  hospital_id: zod.string().uuid(),
  registration_number: zod.string(),
  date_of_birth: zod.string().date(),
  // 법정대리인 동의. 앱 연동(mobile.ts hospitalLinkSchema)과 같은 동의를 웹에서도
  // 받는다 - 연결되면 아이 차트 전체가 이 계정에 열린다.
  guardian_consent: zod.literal(true),
});
router.post(
  "/patient",
  linkAttemptLimiter,
  validateRequestBody(postPatientSchema),
  async (req, res) => {
    const data = req.body;

    const hash = hashRegistrationNumber(data.registration_number);

    const patient = await prisma.patient.findUnique({
      where: {
        registration_number_hash_hospital_id: {
          registration_number_hash: hash,
          hospital_id: data.hospital_id,
        },
      },
    });

    if (patient == null) {
      res.sendStatus(404);
      return;
    }

    const dateOfBirth = await decryptSymmetric(patient.encrypted_date_of_birth);
    if (dateOfBirth !== data.date_of_birth) {
      res.sendStatus(404);
      return;
    }

    await prisma
      .$transaction([
        prisma.user_patient.create({
          data: {
            user_id: req.authSession!.user_id,
            patient_id: patient.id,
          },
        }),
        prisma.patient_consent.create({
          data: {
            patient_id: patient.id,
            given_by: req.authSession!.user_id,
            role: "legal_guardian",
            version: CONSENT_VERSION,
          },
        }),
      ])
      .catch((err) => {
        if (
          err instanceof PrismaClientKnownRequestError &&
          err.code === "P2002"
        ) {
          res.status(400).json({ message: "Already registered" });
        } else {
          res.sendStatus(500);
        }
      });
    if (!res.headersSent) res.sendStatus(201);
  },
);

router.delete("/patient/:patientId", async (req, res) => {
  await prisma.user_patient.deleteMany({
    where: {
      user_id: req.authSession!.user_id,
      patient_id: req.params.patientId,
    },
  });
  res.sendStatus(200);
});

export default router;
