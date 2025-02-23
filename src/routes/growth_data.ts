import express from "express";
import prisma from "../lib/prisma";

const router = express.Router();

router.get("/", async (req, res) => {
  const data = await prisma.growth_data.findMany();

  res.json(data);
});

export default router;
