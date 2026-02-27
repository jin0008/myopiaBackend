import express from "express";
import prisma from "../lib/prisma";
import zod from "zod";
import {
  approvedProfessionalRequired,
  hospitalAdminRequired,
  loginRequired,
  validateRequestBody,
} from "../lib/middlewares";
import { sex } from "@prisma/client";
import { PrismaClientKnownRequestError } from "@prisma/client/runtime/library";
import { WrongArgumentsMessage } from "../lib/util";
import { decryptSymmetric, encryptSymmetric } from "../services/encrpytion";

const router = express.Router();

router.get("/", approvedProfessionalRequired, async (req, res) => {
  const orderBy = req.query.orderBy as string;
  const allowedOrderBys = [
    "created_at",
    "registration_number",
    "date_of_birth",
    "sex",
  ];
  if (!allowedOrderBys.includes(orderBy)) {
    res.sendStatus(400);
    return;
  }
  const orderByDirection =
    req.query.orderByDirection === "asc" ? "asc" : "desc";
  const data = await prisma.hospital
    .findUnique({
      where: {
        id: req.healthcare_professional!.hospital_id,
      },
      include: {
        patient: true,
      },
    })
    .then((data) => data?.patient ?? [])
    .then(async (patients) => {
      return Promise.all(
        patients.map(async (patient) => ({
          ...patient,
          date_of_birth: patient.encrypted_date_of_birth
            ? await decryptSymmetric(patient.encrypted_date_of_birth)
            : patient.date_of_birth,
          registration_number: patient.encrypted_registration_number
            ? await decryptSymmetric(patient.encrypted_registration_number)
            : patient.registration_number,
        })),
      );
    })
    .then((data) => {
      return data.sort((a, b) => {
        if (orderBy === "created_at") {
          return a.created_at.getTime() - b.created_at.getTime();
        } else if (orderBy === "registration_number") {
          return a.registration_number!.localeCompare(b.registration_number!);
        } else if (orderBy === "date_of_birth") {
          return (
            new Date(a.date_of_birth!).getTime() -
            new Date(b.date_of_birth!).getTime()
          );
        } else if (orderBy === "sex") {
          return a.sex.localeCompare(b.sex);
        }
        return 0;
      });
    })
    .then((data) => {
      return orderByDirection === "asc" ? data : data.reverse();
    });

  res.json(data);
});

router.get("/deleteRequest", hospitalAdminRequired, async (req, res) => {
  const data = await prisma.pending_patient_deletion.findMany({
    where: {
      patient: {
        hospital_id: req.healthcare_professional!.hospital_id,
      },
    },
    include: {
      patient: true,
      healthcare_professional: true,
    },
  });
  res.json(data);
});

const deleteRequestSchema = zod.object({
  patient_id: zod.string().uuid(),
});
router.post(
  "/deleteRequest",
  validateRequestBody(deleteRequestSchema),
  approvedProfessionalRequired,
  async (req, res) => {
    const patientHospitalId = await prisma.patient
      .findUnique({
        where: {
          id: req.body.patient_id,
        },
        select: {
          hospital_id: true,
        },
      })
      .then((result) => result?.hospital_id);

    if (patientHospitalId == null) {
      res.sendStatus(404);
      return;
    }
    if (patientHospitalId !== req.healthcare_professional!.hospital_id) {
      res.sendStatus(403);
      return;
    }

    await prisma.pending_patient_deletion.upsert({
      where: {
        patient_id: req.body.patient_id,
      },
      update: {
        requested_by: req.healthcare_professional!.user_id,
      },
      create: {
        patient_id: req.body.patient_id,
        requested_by: req.healthcare_professional!.user_id,
      },
    });
    res.sendStatus(200);
  },
);

router.post(
  "/deleteRequest/:id/approve",
  hospitalAdminRequired,
  async (req, res) => {
    const patientId = String(req.params.id);
    const patientHospitalId = await prisma.patient
      .findUnique({
        where: {
          id: patientId,
        },
        select: {
          hospital_id: true,
        },
      })
      .then((result) => result?.hospital_id);

    if (patientHospitalId == null) {
      res.sendStatus(404);
      return;
    }
    if (patientHospitalId !== req.healthcare_professional!.hospital_id) {
      res.sendStatus(403);
      return;
    }

    await prisma.$transaction([
      prisma.pending_patient_deletion.delete({
        where: {
          patient_id: patientId,
        },
      }),
      prisma.patient.delete({
        where: {
          id: patientId,
        },
      }),
    ]);
    res.sendStatus(200);
  },
);

router.post(
  "/deleteRequest/:id/reject",
  hospitalAdminRequired,
  async (req, res) => {
    const patientId = String(req.params.id);
    await prisma.pending_patient_deletion.delete({
      where: {
        patient_id: patientId,
      },
    });
    res.sendStatus(200);
  },
);

router.get("/:patientId", loginRequired, async (req, res) => {
  await prisma.patient
    .findFirst({
      where: {
        id: String(req.params.patientId),
        OR: [
          {
            hospital: {
              healthcare_professional: {
                some: {
                  user: {
                    id: req.authSession!.user_id,
                  },
                },
              },
            },
          },
          {
            user_patient: {
              some: {
                user: {
                  id: req.authSession!.user_id,
                },
              },
            },
          },
        ],
      },
      include: {
        hospital: true,
        ethnicity: true,
        measurement: true,
        patient_treatment: true,
        patient_k: true,
      },
    })
    .then(async (data) => {
      if (data == null) {
        res.sendStatus(404);
        return;
      }
      return {
        ...data,
        date_of_birth: data.encrypted_date_of_birth
          ? await decryptSymmetric(data.encrypted_date_of_birth)
          : data.date_of_birth,
        registration_number: data.encrypted_registration_number
          ? await decryptSymmetric(data.encrypted_registration_number)
          : data.registration_number,
      };
    })
    .then((data) => {
      res.json(data);
    });
});

const postPatientSchema = zod.object({
  registration_number: zod.string(),
  date_of_birth: zod.string().date(),
  sex: zod.nativeEnum(sex),
  ethnicity_id: zod.string().uuid(),
  email: zod.string().email().optional(),
});
router.post("/", approvedProfessionalRequired, async (req, res) => {
  let data;
  try {
    data = postPatientSchema.parse(req.body);
  } catch {
    res.status(400).json(WrongArgumentsMessage);
    return;
  }

  const existingPatient = await prisma.patient.findFirst({
    where: {
      // Fix: Trim and Case-Insensitive check
      registration_number: {
        equals: data.registration_number.trim(),
        mode: "insensitive",
      },
      hospital_id: req.healthcare_professional!.hospital_id,
    },
  });

  if (existingPatient) {
    res.status(409).json({
      message: "Patient with this registration number already exists.",
    });
    return;
  }

  await prisma.patient.create({
    data: {
      sex: data.sex,
      ethnicity_id: data.ethnicity_id,
      email: data.email,
      encrypted_registration_number: await encryptSymmetric(
        data.registration_number,
      ).then((encrypted) => Uint8Array.from(encrypted)),
      encrypted_date_of_birth: await encryptSymmetric(data.date_of_birth).then(
        (encrypted) => Uint8Array.from(encrypted),
      ),
      hospital_id: req.healthcare_professional!.hospital_id,
      creator_id: req.authSession!.user_id,
    },
  });
  res.sendStatus(201);
});

const patchPatientSchema = zod.object({
  date_of_birth: zod.string().date().optional(),
  sex: zod.nativeEnum(sex).optional(),
});

router.patch(
  "/:patientId",
  validateRequestBody(patchPatientSchema),
  approvedProfessionalRequired,
  async (req, res) => {
    const target = await prisma.patient.findUnique({
      where: {
        id: String(req.params.patientId),
      },
      select: {
        hospital_id: true,
      },
    });
    if (target == null) {
      res.sendStatus(404);
      return;
    } else if (
      target.hospital_id !== req.healthcare_professional!.hospital_id
    ) {
      res.sendStatus(403);
      return;
    }
    const data = req.body as zod.infer<typeof patchPatientSchema>;
    await prisma.patient.update({
      where: {
        id: String(req.params.patientId),
      },
      data: {
        encrypted_date_of_birth: data.date_of_birth
          ? await encryptSymmetric(data.date_of_birth).then((encrypted) =>
              Uint8Array.from(encrypted),
            )
          : undefined,
        sex: data.sex,
      },
    });
    res.sendStatus(200);
  },
);

router.delete("/:patientId", hospitalAdminRequired, async (req, res, next) => {
  await prisma.patient
    .delete({
      where: {
        id: String(req.params.patientId),
        hospital_id: req.healthcare_professional!.hospital_id,
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
});

export default router;
