import express from "express";
import prisma from "../lib/prisma";
import {
  hospitalAdminRequired,
  loginRequired,
  siteAdminRequired,
} from "../lib/middlewares";
import zod from "zod";

const router = express.Router();

router.get("/", async (req, res) => {
  await prisma.hospital
    .findMany({
      select: {
        id: true,
        name: true,
        code: true,
        country: true,
        _count: {
          select: {
            patient: true,
          },
        },
      },
      orderBy: {
        patient: {
          _count: "desc",
        },
      },
    })
    .then((result) =>
      res.json(
        result.map((h) => ({
          ...h,
          patientCount: h._count.patient,
        }))
      )
    );
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
  loginRequired,
  siteAdminRequired,
  async (req, res) => {
    await getHospitalMembers(req.params.hostpital_id).then((result) =>
      res.json(result)
    );
  }
);

router.get(
  "/healthcare_professional",
  loginRequired,
  hospitalAdminRequired,
  async (req, res) => {
    await getHospitalMembers(req.healthcare_professional.hospital_id).then(
      (result) => res.json(result)
    );
  }
);

router.delete(
  "/healthcare_professional/:id",
  loginRequired,
  hospitalAdminRequired,
  async (req, res) => {
    const target = await prisma.healthcare_professional.findUnique({
      where: {
        user_id: req.params.id,
      },
    });
    if (target == null) {
      res.sendStatus(404);
      return;
    }
    if (target.hospital_id !== req.healthcare_professional.hospital_id) {
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
          user_id: req.params.id,
        },
      })
      .then(() => res.sendStatus(200));
  }
);

export const hospitalMemberPatchType = zod.object({
  approved: zod.literal(true).optional(),
  is_admin: zod.literal(true).optional(),
});

router.patch(
  "/healthcare_professional/:id",
  loginRequired,
  hospitalAdminRequired,
  async (req, res) => {
    const body = req.body;

    let data;
    try {
      data = hospitalMemberPatchType.parse(body);
    } catch {
      res.sendStatus(400);
      return;
    }

    await prisma.healthcare_professional
      .update({
        where: {
          user_id: req.params.id,
        },
        data: data,
      })
      .then(() => res.sendStatus(200));
  }
);

export default router;
