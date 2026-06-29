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
import bcrypt from "bcrypt";
import { hashRegistrationNumber } from "../lib/hash";
import { auditContextFromRequest, writeAuditLog } from "../services/audit";

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
          date_of_birth: await decryptSymmetric(
            patient.encrypted_date_of_birth,
          ),
          registration_number: await decryptSymmetric(
            patient.encrypted_registration_number,
          ),
        })),
      );
    })
    .then((data) => {
      const multiplier = orderByDirection === "asc" ? 1 : -1;
      let comparatorFunction: (
        a: (typeof data)[number],
        b: (typeof data)[number],
      ) => number;
      switch (orderBy) {
        case "created_at":
          comparatorFunction = (a, b) =>
            multiplier * (a.created_at.getTime() - b.created_at.getTime());
          break;
        case "registration_number":
          comparatorFunction = (a, b) =>
            multiplier *
            a.registration_number.localeCompare(b.registration_number);
          break;
        case "date_of_birth":
          comparatorFunction = (a, b) =>
            multiplier * a.date_of_birth.localeCompare(b.date_of_birth);
          break;
        case "sex":
          comparatorFunction = (a, b) =>
            multiplier * a.sex.localeCompare(b.sex);
          break;
        default:
          throw new Error("this should not happen");
      }
      return data.sort(comparatorFunction);
    });

  // High-risk read: bulk patient list with decrypted PII (reg. number, DOB).
  writeAuditLog({
    ...auditContextFromRequest(req),
    tableName: "patient",
    action: "READ",
    hospitalId: req.healthcare_professional!.hospital_id,
    newValue: { scope: "patient_list", count: data.length },
  }).catch(console.error);

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

    const [, deleted] = await prisma.$transaction([
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

    writeAuditLog({
      ...auditContextFromRequest(req),
      tableName: "patient",
      recordId: deleted.id,
      action: "DELETE",
      hospitalId: deleted.hospital_id,
      patientId: deleted.id,
      oldValue: {
        sex: deleted.sex,
        ethnicity_id: deleted.ethnicity_id,
        created_at: deleted.created_at,
      },
    }).catch(console.error);

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

      // High-risk read: full patient record with decrypted PII (reg. number,
      // DOB) plus all clinical measurements.
      writeAuditLog({
        ...auditContextFromRequest(req),
        tableName: "patient",
        recordId: data.id,
        action: "READ",
        hospitalId: data.hospital_id,
        patientId: data.id,
      }).catch(console.error);

      res.json({
        ...data,
        date_of_birth: await decryptSymmetric(data.encrypted_date_of_birth),
        registration_number: await decryptSymmetric(
          data.encrypted_registration_number,
        ),
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

    const trimmedRegistrationNumber = data.registration_number.trim();
    const hash = hashRegistrationNumber(trimmedRegistrationNumber);

    const created = await prisma.patient.create({
      data: {
        sex: data.sex,
        ethnicity_id: data.ethnicity_id,
        email: data.email,
        encrypted_registration_number: await encryptSymmetric(
          trimmedRegistrationNumber,
        ).then((encrypted) => Uint8Array.from(encrypted)),
        registration_number_hash: hash,
        encrypted_date_of_birth: await encryptSymmetric(
          data.date_of_birth,
        ).then((encrypted) => Uint8Array.from(encrypted)),
        hospital_id: req.healthcare_professional!.hospital_id,
        creator_id: req.authSession!.user_id,
      },
    });

    // Audit the creation with non-PII metadata only. Registration number, date
    // of birth and email are sensitive personal data and are never written to
    // the audit log.
    writeAuditLog({
      ...auditContextFromRequest(req),
      tableName: "patient",
      recordId: created.id,
      action: "CREATE",
      hospitalId: created.hospital_id,
      patientId: created.id,
      newValue: { sex: created.sex, ethnicity_id: created.ethnicity_id },
    }).catch(console.error);

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
      .then((updated) => {
        // Record which fields changed; sensitive values (date of birth) are
        // intentionally not stored in the audit log.
        writeAuditLog({
          ...auditContextFromRequest(req),
          tableName: "patient",
          recordId: patientId,
          action: "UPDATE",
          hospitalId: updated.hospital_id,
          patientId,
          changedFields: Object.keys(data).filter(
            (key) => (data as Record<string, unknown>)[key] !== undefined,
          ),
        }).catch(console.error);
        res.sendStatus(200);
      })
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
    .then((deleted) => {
      writeAuditLog({
        ...auditContextFromRequest(req),
        tableName: "patient",
        recordId: deleted.id,
        action: "DELETE",
        hospitalId: deleted.hospital_id,
        patientId: deleted.id,
        oldValue: {
          sex: deleted.sex,
          ethnicity_id: deleted.ethnicity_id,
          created_at: deleted.created_at,
        },
      }).catch(console.error);
      res.sendStatus(200);
    })
    .catch((e) => {
      if (e instanceof PrismaClientKnownRequestError && e.code === "P2025") {
        res.sendStatus(404);
        return;
      }
      next(e);
    });
});

export default router;
