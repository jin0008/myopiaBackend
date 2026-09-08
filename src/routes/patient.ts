import express from "express";
import prisma from "../lib/prisma";
import zod from "zod";
import {
  approvedProfessionalRequired,
  hospitalAdminRequired,
  loginRequired,
  validateRequestBody,
} from "../lib/middlewares";
import { audit_action, myopia_status, sex } from "@prisma/client";
import { PrismaClientKnownRequestError } from "@prisma/client/runtime/library";
import { decryptSymmetric, encryptSymmetric } from "../services/encrpytion";
import { isPatientInHospital } from "../lib/authorization";
import bcrypt from "bcrypt";
import { hashRegistrationNumber } from "../lib/hash";
import { auditContextFromRequest, writeAuditLog } from "../services/audit";
import { createLinkInvite, sendInviteEmail } from "../services/linkInvite";

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
    // 도수는 보호자가 앱에서 적는 값이다. 진료에서 상태만 고칠 때 함께
    // 돌려보내지 않으면, 새 행에 도수가 비어 그 값이 화면에서 사라진다.
    mother_myopia_status: zod.object({
      status: zod.nativeEnum(myopia_status),
      sph_od: zod.number().min(-20).max(20).nullish(),
      sph_os: zod.number().min(-20).max(20).nullish(),
    }),
    father_myopia_status: zod.object({
      status: zod.nativeEnum(myopia_status),
      sph_od: zod.number().min(-20).max(20).nullish(),
      sph_os: zod.number().min(-20).max(20).nullish(),
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
            source: "clinic",
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
            source: "clinic",
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
            sph_od: data.mother_myopia_status.sph_od ?? null,
            sph_os: data.mother_myopia_status.sph_os ?? null,
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
            sph_od: data.father_myopia_status.sph_od ?? null,
            sph_os: data.father_myopia_status.sph_os ?? null,
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

/* ------------------------------------------------------------------ *
 * 연동 초대                                                           *
 *                                                                    *
 * 부모가 병원 등록번호를 입력해 연동하던 방식은 등록번호가 연속된      *
 * 숫자라 대입이 가능했다. 병원이 일회용 링크를 건네는 쪽으로 옮긴다.   *
 * 등록번호 방식은 링크를 잃어버린 사람을 위해 남겨 둔다.               *
 * ------------------------------------------------------------------ */

const linkInviteSchema = zod.object({
  /** 있으면 그 주소로 메일을 보낸다. 없으면 링크·QR 만 돌려준다. */
  email: zod.string().trim().email().max(254).optional(),
});

/** POST /api/patient/:patientId/link-invite — 자기 병원 환자만. */
router.post(
  "/:patientId/link-invite",
  approvedProfessionalRequired,
  validateRequestBody(linkInviteSchema),
  async (req, res) => {
    const patientId = String(req.params.patientId);
    const hospitalId = req.healthcare_professional!.hospital_id;
    if (!(await isPatientInHospital(patientId, hospitalId))) {
      res.sendStatus(403);
      return;
    }

    // 새로 만들면 앞서 준 링크는 못 쓰게 한다. 같은 환자에게 살아 있는
    // 링크가 여럿이면 어느 것이 유효한지 아무도 모른다.
    await prisma.child_link_invite.updateMany({
      where: { patient_id: patientId, used_at: null, revoked_at: null },
      data: { revoked_at: new Date() },
    });

    const body = req.body as zod.infer<typeof linkInviteSchema>;
    const hospital = await prisma.hospital.findUnique({
      where: { id: hospitalId },
      select: { name: true },
    });

    const invite = await createLinkInvite({
      hospitalId,
      patientId,
      createdBy: req.healthcare_professional!.user_id,
      sentTo: body.email ?? null,
    });

    // 메일이 실패해도 링크는 이미 유효하다. 발급을 되돌리면 화면에 QR 도
    // 못 띄우게 되는데, 그건 메일보다 흔히 쓰는 경로다.
    let emailSent = false;
    if (body.email) {
      try {
        await sendInviteEmail({
          to: body.email,
          hospitalName: hospital?.name ?? "",
          url: invite.url,
          expiresAt: invite.expiresAt,
        });
        emailSent = true;
      } catch (e) {
        console.error("[link-invite] email failed", e);
      }
    }

    writeAuditLog({
      ...auditContextFromRequest(req),
      action: audit_action.CREATE,
      tableName: "child_link_invite",
      hospitalId,
      patientId,
    }).catch(console.error);

    res.status(201).json({
      url: invite.url,
      expiresAt: invite.expiresAt.toISOString(),
      // 보냈다고 말하려면 실제로 나갔어야 한다. 실패했는데 "전송됨"이라고
      // 하면 병원은 기다리고 부모는 못 받는다.
      emailSent,
    });
  },
);

export default router;
