import express from "express";
import prisma from "../lib/prisma";
import { WrongArgumentsMessage } from "../lib/util";
import { sex } from "@prisma/client";

const router = express.Router();

router.get("/ethnicity_list", async (req, res) => {
  const data = await prisma.growth_data.findMany({
    select: {
      ethnicity: true,
    },
    distinct: ["ethnicity"],
  });
  res.status(200).json(data.map((d: any) => d.ethnicity));
});

router.get("/", async (req, res) => {
  const ethnicity = req.query.ethnicity;
  const sex = req.query.sex;

  if (!["male", "female"].includes(sex as any)) {
    res.status(400).json(WrongArgumentsMessage);
    return;
  }

  if (typeof ethnicity !== "string") {
    res.status(400).json(WrongArgumentsMessage);
    return;
  }

  const data = await prisma.growth_data.findMany({
    where: {
      sex: sex as sex,
      ethnicity: ethnicity,
    },
  });

  res.json(data);
});

export default router;
