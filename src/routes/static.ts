import express from "express";
import prisma from "../lib/prisma";

const router = express.Router();

router.get("/country", async (req, res) => {
  await prisma.country.findMany().then((result: any[]) => res.json(result));
});

router.get("/instrument", async (req, res) => {
  await prisma.instrument.findMany().then((result: any[]) => res.json(result));
});

router.get("/ethnicity", async (req, res) => {
  await prisma.ethnicity.findMany().then((result: any[]) => res.json(result));
});

router.get("/treatment", async (req, res) => {
  await prisma.treatment.findMany().then((result: any[]) => res.json(result));
});

export default router;
