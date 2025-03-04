import express from "express";
import prisma from "../lib/prisma";
import zod from "zod";

import { getAuthSession, WrongArgumentsMessage } from "../lib/util";
import {
  approvedProfessionalRequired,
  loginRequired,
  siteAdminRequired,
} from "../lib/middlewares";
import { hospitalMemberPatchType } from "./hospital";

const router = express.Router();
router.use(loginRequired);

const existingHospitalType = zod.object({
  id: zod.string().uuid(),
});

const newHospitalType = zod.object({
  name: zod.string().nonempty(),
  country_id: zod.string().uuid(),
  code: zod.string().regex(/^[a-zA-Z0-9]{1,10}$/),
});

const postType = zod.object({
  name: zod.string().nonempty(),
  country_id: zod.string().uuid(),
  hospital: zod.union([existingHospitalType, newHospitalType]),
  role: zod.string(),
  default_ethnicity_id: zod.string().uuid().nullable().optional(),
  default_instrument_id: zod.string().uuid().nullable().optional(),
});

router.post("/", async (req, res) => {
  const body = req.body;

  let data;

  try {
    data = postType.parse(body);
  } catch {
    res.status(400).json(WrongArgumentsMessage);
    return;
  }

  const existingHospital = existingHospitalType.safeParse(data.hospital);
  if (existingHospital.success) {
    await prisma.healthcare_professional.create({
      data: {
        user_id: req.authSession.user_id,
        name: data.name,
        country_id: data.country_id,
        hospital_id: existingHospital.data.id,
        role: data.role,
        default_ethnicity_id: data.default_ethnicity_id,
        default_instrument_id: data.default_instrument_id,
      },
    });
    res.sendStatus(201);
    return;
  }

  //User that creates the hospital is the admin of the hospital
  const newHospital = newHospitalType.safeParse(data.hospital);
  if (newHospital.success) {
    await prisma.healthcare_professional.create({
      data: {
        user: {
          connect: {
            id: req.authSession.user_id,
          },
        },
        name: data.name,
        country: {
          connect: {
            id: data.country_id,
          },
        },
        hospital: {
          create: {
            name: newHospital.data.name,
            country_id: newHospital.data.country_id,
            code: newHospital.data.code,
          },
        },
        approved: true,
        is_admin: true,
        role: data.role,
        default_ethnicity:
          data.default_ethnicity_id == null
            ? undefined
            : {
                connect: {
                  id: data.default_ethnicity_id,
                },
              },
        default_instrument:
          data.default_instrument_id == null
            ? undefined
            : {
                connect: {
                  id: data.default_instrument_id,
                },
              },
      },
    });
    res.sendStatus(201);
  }
});

const patchType = zod.object({
  default_ethnicity_id: zod.string().nullable().optional(),
  default_instrument_id: zod.string().nullable().optional(),
  role: zod.string().optional(),
});

router.patch("/", approvedProfessionalRequired, async (req, res) => {
  const authSession = await getAuthSession(req);

  const userId = authSession?.user_id;

  if (userId == null) {
    res.sendStatus(401);
    return;
  }

  const body = req.body;

  let data;
  try {
    data = patchType.parse(body);
  } catch {
    res.sendStatus(400);
    return;
  }

  await prisma.healthcare_professional.update({
    where: {
      user_id: userId,
    },
    data: data,
  });

  res.sendStatus(200);
});

const patchHospitalType = zod.union([existingHospitalType, newHospitalType]);

router.patch("/hospital", approvedProfessionalRequired, async (req, res) => {
  const data = patchHospitalType.safeParse(req.body);
  if (!data.success) {
    res.status(400).json(WrongArgumentsMessage);
    return;
  }
  const hospitalData = data.data;

  const existingHospital = existingHospitalType.safeParse(hospitalData);
  if (existingHospital.success) {
    await prisma.healthcare_professional.update({
      where: {
        user_id: req.authSession.user_id,
      },
      data: {
        hospital: {
          connect: {
            id: existingHospital.data.id,
          },
        },
        approved: false,
      },
    });
    res.sendStatus(200);
    return;
  }

  const newHospital = newHospitalType.safeParse(hospitalData);
  if (newHospital.success) {
    await prisma.healthcare_professional.update({
      where: {
        user_id: req.authSession.user_id,
      },
      data: {
        hospital: {
          create: {
            name: newHospital.data.name,
            country_id: newHospital.data.country_id,
            code: newHospital.data.code,
          },
        },
        approved: true,
        is_admin: true,
      },
    });
    res.sendStatus(200);
  }
});

const hospitalMemberPatchTypeAdmin = zod.object({
  approved: zod.boolean().optional(),
  is_admin: zod.boolean().optional(),
});
router.patch(
  "/:healthcare_professional_id",
  loginRequired,
  siteAdminRequired,
  async (req, res) => {
    const body = req.body;

    let data;
    try {
      data = hospitalMemberPatchTypeAdmin.parse(body);
    } catch {
      res.sendStatus(400);
      return;
    }

    await prisma.healthcare_professional
      .update({
        where: {
          user_id: req.params.healthcare_professional_id,
        },
        data: data,
      })
      .then(() => res.sendStatus(200));
  }
);

router.delete(
  "/:healthcare_professional_id",
  loginRequired,
  siteAdminRequired,
  async (req, res) => {
    await prisma.healthcare_professional
      .delete({
        where: {
          user_id: req.params.healthcare_professional_id,
        },
      })
      .then(() => res.sendStatus(200));
  }
);

export default router;
