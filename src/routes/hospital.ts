import express from "express";
import prisma from "../lib/prisma";

const router = express.Router();

router.get("/", async (req, res) => {
  await prisma.hospital
    .findMany({
      include: {
        country: true,
      },
    })
    .then((result) => res.json(result));
});

export default router;
