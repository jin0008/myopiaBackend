import express from "express";
import prisma from "../lib/prisma";
import { WrongArgumentsMessage } from "../lib/session";
import { sex } from "@prisma/client";

const router = express.Router();

// Display order for the chart's "reference data" selector. Asian references are
// listed first because the primary users are Korean. Any ethnicity not listed
// here is appended afterwards in alphabetical order.
const ETHNICITY_ORDER = [
  "Asian",
  "EastAsian-CREAMkids",
  "Caucasian",
  "EuropeAus-CREAMkids",
];

router.get("/ethnicity_list", async (req, res) => {
  const data = await prisma.growth_data.findMany({
    select: {
      ethnicity: true,
    },
    distinct: ["ethnicity"],
  });
  const all = data.map((d) => d.ethnicity);
  const ordered = [
    ...ETHNICITY_ORDER.filter((e) => all.includes(e)),
    ...all.filter((e) => !ETHNICITY_ORDER.includes(e)).sort(),
  ];
  res.status(200).json(ordered);
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
