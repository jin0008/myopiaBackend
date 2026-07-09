import express from "express";
import zod from "zod";
import prisma from "../lib/prisma";
import {
  loginRequired,
  siteAdminRequired,
  validateRequestBody,
} from "../lib/middlewares";
import {
  AXIAL_QUERY,
  PROGRESSION_ALERT,
  SE_ALERT,
} from "../lib/constants";
import { auditContextFromRequest, writeAuditLog } from "../services/audit";

const router = express.Router();

const SETTING_ID = 1;

/** Compiled-in defaults, used when the singleton row hasn't been seeded yet. */
const DEFAULTS = {
  axial_min: AXIAL_QUERY.minNormal,
  axial_max: AXIAL_QUERY.maxNormal,
  axial_decrease_mm: AXIAL_QUERY.decreaseMm,
  axial_increase_mm_per_year: AXIAL_QUERY.increaseMmPerYear,
  se_min: SE_ALERT.min,
  se_progression_d_per_year: PROGRESSION_ALERT.seDioptersPerYear,
};

/**
 * Audit context for site-admin routes. `siteAdminRequired` doesn't populate
 * req.healthcare_professional, so resolve the actor from the DB (falling back to
 * the user's email) so the log carries the same actor detail as the rest.
 */
async function adminAuditContext(req: express.Request) {
  const base = auditContextFromRequest(req);
  const userId = req.authSession?.user_id;
  if (!userId) return base;
  const hp = await prisma.healthcare_professional.findUnique({
    where: { user_id: userId },
    select: { name: true, role: true, hospital_id: true },
  });
  if (hp) {
    return {
      ...base,
      actorName: hp.name,
      actorRole: hp.role,
      actorHospitalId: hp.hospital_id,
    };
  }
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true },
  });
  return { ...base, actorName: user?.email ?? null, actorRole: "site_admin" };
}

// GET /alert_setting — read the global thresholds. Available to any logged-in
// user (the chart input popup syncs its warning ranges to these values).
router.get("/", loginRequired, async (_req, res) => {
  const row = await prisma.alert_setting.findUnique({
    where: { id: SETTING_ID },
  });
  res.json(row ?? { id: SETTING_ID, ...DEFAULTS });
});

const updateSchema = zod
  .object({
    axial_min: zod.number().min(0).max(40),
    axial_max: zod.number().min(0).max(40),
    axial_decrease_mm: zod.number().min(0).max(10),
    axial_increase_mm_per_year: zod.number().min(0).max(10),
    se_min: zod.number().min(-40).max(0),
    se_progression_d_per_year: zod.number().min(0).max(20),
  })
  .refine((v) => v.axial_min < v.axial_max, {
    message: "axial_min must be less than axial_max",
    path: ["axial_min"],
  });

// PUT /alert_setting — site admin updates the global thresholds.
router.put(
  "/",
  siteAdminRequired,
  validateRequestBody(updateSchema),
  async (req, res) => {
    const data = req.body as zod.infer<typeof updateSchema>;
    const oldValue = await prisma.alert_setting.findUnique({
      where: { id: SETTING_ID },
    });
    const updated = await prisma.alert_setting.upsert({
      where: { id: SETTING_ID },
      update: data,
      create: { id: SETTING_ID, ...data },
    });
    await writeAuditLog({
      ...(await adminAuditContext(req)),
      tableName: "alert_setting",
      // record_id is a UUID column; the singleton's integer id (1) isn't a valid
      // UUID, so leave it null. The table_name alone identifies this record.
      action: "UPDATE",
      oldValue,
      newValue: updated,
    });
    res.json(updated);
  },
);

export default router;
