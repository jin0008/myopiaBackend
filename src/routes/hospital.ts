import express from "express";
import prisma from "../lib/prisma";
import {
  hospitalAdminRequired,
  siteAdminRequired,
  validateRequestBody,
} from "../lib/middlewares";
import zod from "zod";
import { decryptSymmetric } from "../services/encrpytion";
import { compareHospitalNames, normalizeNameKo } from "../lib/hospitalName";
import { auditContextFromRequest, writeAuditLog } from "../services/audit";

const router = express.Router();

router.get("/", async (req, res) => {
  const [hospitals, patientCounts] = await Promise.all([
    prisma.hospital.findMany({
      select: {
        id: true,
        name: true,
        name_ko: true,
        code: true,
        country: {
          select: {
            id: true,
            name: true,
            code: true,
          },
        },
      },
    }),
    prisma.patient.groupBy({
      by: ["hospital_id"],
      _count: {
        _all: true,
      },
    }),
  ]);

  const patientCountMap = new Map(
    patientCounts.map((entry) => [entry.hospital_id, entry._count._all]),
  );

  hospitals.sort(compareHospitalNames);
  const payload = hospitals.map((hospital) => ({
    ...hospital,
    patientCount: patientCountMap.get(hospital.id) ?? 0,
  }));

  res.json(payload);
});

/* ---- 한글 표시 이름 ---------------------------------------------- *
 * name(가입 때 이름)은 건드리지 않고 name_ko 만 고친다. 빈 값·공백은    *
 * NULL 로 저장되며, 그때 화면에는 name 이 그대로 보인다.               *
 * ------------------------------------------------------------------ */
const hospitalNameKoPatchType = zod.object({
  name_ko: zod.string().max(100).nullable(),
});

async function updateHospitalNameKo(
  req: express.Request,
  res: express.Response,
  hospitalId: string,
) {
  const parsed = hospitalNameKoPatchType.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "name_ko must be a string or null" });
    return;
  }
  const before = await prisma.hospital.findUnique({
    where: { id: hospitalId },
    select: { id: true, name: true, name_ko: true },
  });
  if (before == null) {
    res.sendStatus(404);
    return;
  }
  const nameKo = normalizeNameKo(parsed.data.name_ko, before.name);
  const after = await prisma.hospital.update({
    where: { id: hospitalId },
    data: { name_ko: nameKo },
    select: { id: true, name: true, name_ko: true },
  });
  if (before.name_ko !== after.name_ko) {
    await writeAuditLog({
      ...auditContextFromRequest(req),
      tableName: "hospital",
      recordId: hospitalId,
      action: "UPDATE",
      hospitalId,
      oldValue: { name_ko: before.name_ko },
      newValue: { name_ko: after.name_ko },
      changedFields: ["name_ko"],
    });
  }
  res.json(after);
}

// 병원 관리자: 자기 병원의 한글 이름
router.patch("/name_ko", hospitalAdminRequired, async (req, res) => {
  await updateHospitalNameKo(
    req,
    res,
    req.healthcare_professional!.hospital_id,
  );
});

// 사이트 관리자: 아무 병원의 한글 이름
router.patch("/:hospital_id/name_ko", siteAdminRequired, async (req, res) => {
  const id = zod.string().uuid().safeParse(req.params.hospital_id);
  if (!id.success) {
    res.sendStatus(404);
    return;
  }
  await updateHospitalNameKo(req, res, id.data);
});

function getHospitalMembers(hospitalId: string) {
  return prisma.healthcare_professional.findMany({
    where: {
      hospital_id: hospitalId,
    },
    select: {
      user_id: true,
      name: true,
      approved: true,
      is_admin: true,
    },
    orderBy: [
      {
        approved: "asc",
      },
      {
        is_admin: "desc",
      },
      {
        name: "asc",
      },
    ],
  });
}

router.get(
  "/:hostpital_id/healthcare_professional",
  siteAdminRequired,
  async (req, res) => {
    await getHospitalMembers(req.params.hostpital_id as string).then((result) =>
      res.json(result),
    );
  },
);

router.get("/:hospital_id/measurement", siteAdminRequired, async (req, res) => {
  await prisma.patient
    .findMany({
      where: {
        hospital_id: req.params.hospital_id as string,
      },
      include: {
        measurement: true,
      },
    })
    .then((result) =>
      Promise.all(
        result.map(async (patient) => ({
          ...patient,
          date_of_birth: await decryptSymmetric(
            patient.encrypted_date_of_birth,
          ),
          registration_number: await decryptSymmetric(
            patient.encrypted_registration_number,
          ),
        })),
      ),
    )
    .then((result) => res.json(result));
});

router.get(
  "/healthcare_professional",
  hospitalAdminRequired,
  async (req, res) => {
    await getHospitalMembers(req.healthcare_professional!.hospital_id).then(
      (result) => res.json(result),
    );
  },
);

router.delete(
  "/healthcare_professional/:id",
  hospitalAdminRequired,
  async (req, res) => {
    const targetId = String(req.params.id);
    const target = await prisma.healthcare_professional.findUnique({
      where: {
        user_id: targetId,
      },
    });
    if (target == null) {
      res.sendStatus(404);
      return;
    }
    if (target.hospital_id !== req.healthcare_professional!.hospital_id) {
      res.status(403).json({
        message: "Cannot kick a member from another hospital",
      });
      return;
    }
    if (target.is_admin) {
      res.status(403).json({
        message: "Cannot kick an admin",
      });
      return;
    }
    await prisma.healthcare_professional
      .delete({
        where: {
          user_id: targetId,
        },
      })
      .then(() => res.sendStatus(200));
  },
);

export const hospitalMemberPatchType = zod.object({
  approved: zod.literal(true).optional(),
  is_admin: zod.literal(true).optional(),
});

router.patch(
  "/healthcare_professional/:id",
  hospitalAdminRequired,
  validateRequestBody(hospitalMemberPatchType),
  async (req, res) => {
    const targetId = String(req.params.id);
    const target = await prisma.healthcare_professional.findUnique({
      where: {
        user_id: targetId,
      },
    });
    if (target == null) {
      res.sendStatus(404);
      return;
    }
    if (target.hospital_id !== req.healthcare_professional!.hospital_id) {
      res.status(403).json({
        message: "Cannot edit a member from another hospital",
      });
      return;
    }

    const data = req.body;
    await prisma.healthcare_professional
      .update({
        where: {
          user_id: targetId,
        },
        data,
      })
      .then(() => res.sendStatus(200));
  },
);

export default router;
