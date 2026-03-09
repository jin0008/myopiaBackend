import express from "express";
import prisma from "../lib/prisma";
import zod from "zod";
import {
  approvedProfessionalRequired,
  hospitalAdminRequired,
  loginRequired,
  validateRequestBody,
} from "../lib/middlewares";
import { myopia_status, sex } from "@prisma/client";
import { PrismaClientKnownRequestError } from "@prisma/client/runtime/library";
import { decryptSymmetric, encryptSymmetric } from "../services/encrpytion";
import { isPatientInHospital } from "../lib/authorization";

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
    const data = req.body as zod.infer<typeof deleteRequestSchema>;
    const authorized = await isPatientInHospital(
      data.patient_id,
      req.healthcare_professional!.hospital_id,
    );
    if (!authorized) {
      res.sendStatus(403);
      return;
    }

    await prisma.pending_patient_deletion.upsert({
      where: {
        patient_id: data.patient_id,
      },
      update: {
        requested_by: req.healthcare_professional!.user_id,
      },
      create: {
        patient_id: data.patient_id,
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
    const authorized = await isPatientInHospital(
      patientId,
      req.healthcare_professional!.hospital_id,
    );

    if (!authorized) {
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
    const authorized = await isPatientInHospital(
      patientId,
      req.healthcare_professional!.hospital_id,
    );
    if (!authorized) {
      res.sendStatus(403);
      return;
    }
    await prisma.pending_patient_deletion.delete({
      where: {
        patient_id: patientId,
      },
    });
    res.sendStatus(200);
  },
);

router.get(
  "/:patientId/data",
  approvedProfessionalRequired,

  async (req, res) => {
    const patientId = String(req.params.patientId);

    const authorized = await isPatientInHospital(
      patientId,
      req.healthcare_professional!.hospital_id,
    );
    if (!authorized) {
      res.sendStatus(403);
      return;
    }

    const [
      nearwork_activity,
      outdoor_activity,
      mother_myopia_status,
      father_myopia_status,
    ] = await Promise.all([
      prisma.patient_nearwork_activity.findMany({
        where: { patient_id: patientId },
      }),
      prisma.patient_outdoor_activity.findMany({
        where: { patient_id: patientId },
      }),
      prisma.patient_parental_myopia_status.findMany({
        where: {
          patient_id: patientId,
          parent_sex: sex.female,
        },
      }),
      prisma.patient_parental_myopia_status.findMany({
        where: {
          patient_id: patientId,
          parent_sex: sex.male,
        },
      }),
    ]);

    res.json({
      nearwork_activity,
      outdoor_activity,
      mother_myopia_status,
      father_myopia_status,
    });
  },
);

router.get(
  "/:patientId/data/latest",
  approvedProfessionalRequired,
  async (req, res) => {
    const patientId = String(req.params.patientId);
    const authorized = await isPatientInHospital(
      patientId,
      req.healthcare_professional!.hospital_id,
    );
    if (!authorized) {
      res.sendStatus(403);
      return;
    }

    const [
      nearwork_activity,
      outdoor_activity,
      mother_myopia_status,
      father_myopia_status,
    ] = await Promise.all([
      prisma.patient_nearwork_activity.findFirst({
        where: { patient_id: patientId },
        orderBy: { timestamp: "desc" },
      }),
      prisma.patient_outdoor_activity.findFirst({
        where: { patient_id: patientId },
        orderBy: { timestamp: "desc" },
      }),
      prisma.patient_parental_myopia_status.findFirst({
        where: {
          patient_id: patientId,
          parent_sex: sex.female,
        },
        orderBy: { timestamp: "desc" },
      }),
      prisma.patient_parental_myopia_status.findFirst({
        where: {
          patient_id: patientId,
          parent_sex: sex.male,
        },
        orderBy: { timestamp: "desc" },
      }),
    ]);
    res.json({
      nearwork_activity,
      outdoor_activity,
      mother_myopia_status,
      father_myopia_status,
    });
  },
);

const postPatientDataSchema = zod
  .object({
    nearwork_activity: zod.object({
      hours: zod.number(),
    }),
    outdoor_activity: zod.object({
      hours: zod.number(),
    }),
    mother_myopia_status: zod.object({
      status: zod.nativeEnum(myopia_status),
    }),
    father_myopia_status: zod.object({
      status: zod.nativeEnum(myopia_status),
    }),
  })
  .partial();

router.post(
  "/:patientId/data",
  validateRequestBody(postPatientDataSchema),
  approvedProfessionalRequired,
  async (req, res) => {
    const patientId = String(req.params.patientId);
    const authorized = await isPatientInHospital(
      patientId,
      req.healthcare_professional!.hospital_id,
    );
    if (!authorized) {
      res.sendStatus(403);
      return;
    }
    const data = req.body as zod.infer<typeof postPatientDataSchema>;

    const transactions = [];
    if (data.nearwork_activity) {
      transactions.push(
        prisma.patient_nearwork_activity.create({
          data: {
            patient_id: patientId,
            hours: data.nearwork_activity.hours,
          },
        }),
      );
    }
    if (data.outdoor_activity) {
      transactions.push(
        prisma.patient_outdoor_activity.create({
          data: {
            patient_id: patientId,
            hours: data.outdoor_activity.hours,
          },
        }),
      );
    }
    if (data.mother_myopia_status) {
      transactions.push(
        prisma.patient_parental_myopia_status.create({
          data: {
            patient_id: patientId,
            parent_sex: sex.female,
            status: data.mother_myopia_status.status,
          },
        }),
      );
    }
    if (data.father_myopia_status) {
      transactions.push(
        prisma.patient_parental_myopia_status.create({
          data: {
            patient_id: patientId,
            parent_sex: sex.male,
            status: data.father_myopia_status.status,
          },
        }),
      );
    }

    await prisma.$transaction(transactions);
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
        refractive_error: true,
      },
    })
    .then(async (data) => {
      if (data == null) {
        res.sendStatus(404);
        return;
      }
      res.json({
        ...data,
        date_of_birth: data.encrypted_date_of_birth
          ? await decryptSymmetric(data.encrypted_date_of_birth)
          : data.date_of_birth,
        registration_number: data.encrypted_registration_number
          ? await decryptSymmetric(data.encrypted_registration_number)
          : data.registration_number,
      });
    });
});

const postPatientSchema = zod.object({
  registration_number: zod.string(),
  date_of_birth: zod.string().date(),
  sex: zod.nativeEnum(sex),
  ethnicity_id: zod.string().uuid(),
  email: zod.string().email().optional(),
});
router.post(
  "/",
  approvedProfessionalRequired,
  validateRequestBody(postPatientSchema),
  async (req, res) => {
    const data = req.body as zod.infer<typeof postPatientSchema>;

    const exists = await prisma.patient
      .count({
        where: {
          registration_number: {
            equals: data.registration_number.trim(),
            mode: "insensitive",
          },
          hospital_id: req.healthcare_professional!.hospital_id,
        },
      })
      .then((count) => count > 0);

    if (exists) {
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
        encrypted_date_of_birth: await encryptSymmetric(
          data.date_of_birth,
        ).then((encrypted) => Uint8Array.from(encrypted)),
        hospital_id: req.healthcare_professional!.hospital_id,
        creator_id: req.authSession!.user_id,
      },
    });
    res.sendStatus(201);
  },
);

const patchPatientSchema = zod.object({
  date_of_birth: zod.string().date().optional(),
  sex: zod.nativeEnum(sex).optional(),
});

router.patch(
  "/:patientId",
  validateRequestBody(patchPatientSchema),
  approvedProfessionalRequired,
  async (req, res) => {
    const patientId = String(req.params.patientId);
    const authorized = await isPatientInHospital(
      patientId,
      req.healthcare_professional!.hospital_id,
    );
    if (!authorized) {
      res.sendStatus(403);
      return;
    }
    const data = req.body as zod.infer<typeof patchPatientSchema>;
    await prisma.patient
      .update({
        where: {
          id: patientId,
        },
        data: {
          encrypted_date_of_birth: data.date_of_birth
            ? await encryptSymmetric(data.date_of_birth).then((encrypted) =>
                Uint8Array.from(encrypted),
              )
            : undefined,
          sex: data.sex,
        },
      })
      .then(() => res.sendStatus(200))
      .catch((e) => {
        if (e instanceof PrismaClientKnownRequestError && e.code === "P2025") {
          res.sendStatus(404);
          return;
        }
        throw e;
      });
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
