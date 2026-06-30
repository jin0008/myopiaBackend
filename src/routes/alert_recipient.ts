import express from "express";
import zod from "zod";
import { Prisma } from "@prisma/client";
import prisma from "../lib/prisma";
import { hospitalAdminRequired } from "../lib/middlewares";

const router = express.Router();
router.use(hospitalAdminRequired);

const bodySchema = zod.object({
  email: zod.string().email(),
});

// GET /alert_recipient — recipients for the admin's own hospital.
router.get("/", async (req, res) => {
  const hospitalId = req.healthcare_professional!.hospital_id;
  const recipients = await prisma.alert_recipient.findMany({
    where: { hospital_id: hospitalId },
    orderBy: { created_at: "asc" },
  });
  res.json(recipients);
});

// POST /alert_recipient — add a recipient email to the admin's hospital.
router.post("/", async (req, res) => {
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "invalid email" });
    return;
  }
  const hospitalId = req.healthcare_professional!.hospital_id;
  try {
    const recipient = await prisma.alert_recipient.create({
      data: { hospital_id: hospitalId, email: parsed.data.email },
    });
    res.status(201).json(recipient);
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      res.status(409).json({ message: "already registered" });
      return;
    }
    throw error;
  }
});

// DELETE /alert_recipient/:id — remove a recipient from the admin's hospital.
router.delete("/:id", async (req, res) => {
  const hospitalId = req.healthcare_professional!.hospital_id;
  const result = await prisma.alert_recipient.deleteMany({
    where: { id: String(req.params.id), hospital_id: hospitalId },
  });
  if (result.count === 0) {
    res.sendStatus(404);
    return;
  }
  res.sendStatus(204);
});

export default router;
