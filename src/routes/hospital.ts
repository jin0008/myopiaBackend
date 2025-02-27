import express from "express";
import prisma from "../lib/prisma";
import {
  approvedProfessionalRequired,
  hospitalAdminRequired,
  loginRequired,
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
      },
    })
    .then((result) => res.json(result));
});

router.get(
  "/healthcare_professional",
  loginRequired,
  hospitalAdminRequired,
  async (req, res) => {
    const isAdmin = req.healthcare_professional.is_admin;

    if (!isAdmin) {
      res.sendStatus(403);
      return;
    }

    await prisma.healthcare_professional
      .findMany({
        where: {
          hospital_id: req.healthcare_professional.hospital_id,
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
      })
      .then((result) => res.json(result));
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

const memberPatchType = zod.object({
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
      data = memberPatchType.parse(body);
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
