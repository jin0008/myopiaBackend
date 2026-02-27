import express from "express";
import prisma from "../lib/prisma";
import {
  hospitalAdminRequired,
  siteAdminRequired,
  validateRequestBody,
} from "../lib/middlewares";
import zod from "zod";

const router = express.Router();

router.get("/", async (req, res) => {
  const [hospitals, patientCounts] = await Promise.all([
    prisma.hospital.findMany({
      select: {
        id: true,
        name: true,
        code: true,
        country: {
          select: {
            id: true,
            name: true,
            code: true,
          },
        },
      },
      orderBy: {
        name: "asc",
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

  const payload = hospitals.map((hospital) => ({
    ...hospital,
    patientCount: patientCountMap.get(hospital.id) ?? 0,
  }));

  res.json(payload);
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
