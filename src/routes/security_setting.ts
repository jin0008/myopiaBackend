import express from "express";
import zod from "zod";
import prisma from "../lib/prisma";
import { siteAdminRequired, validateRequestBody } from "../lib/middlewares";
import { writeAuditLog } from "../services/audit";
import { adminAuditContext } from "./alert_setting";

const router = express.Router();

const SETTING_ID = 1;

/** 한 줄이 아직 없으면(마이그레이션 전 등) 켜진 것으로 본다. */
const DEFAULTS = { web_2fa_enabled: true };

/** 웹 로그인에서 2단계 인증을 물을지. 로그인할 때마다 DB 에서 읽어 바로 반영된다. */
export async function web2faEnabled(): Promise<boolean> {
  try {
    const row = await prisma.security_setting.findUnique({
      where: { id: SETTING_ID },
      select: { web_2fa_enabled: true },
    });
    return row?.web_2fa_enabled ?? DEFAULTS.web_2fa_enabled;
  } catch (e) {
    // 테이블이 아직 없는 등 읽지 못하면 안전한 쪽(켜짐)으로 본다.
    console.error("security_setting read failed; treating 2fa as enabled", e);
    return true;
  }
}

// GET /security_setting — 사이트 관리자만.
router.get("/", siteAdminRequired, async (_req, res) => {
  const row = await prisma.security_setting.findUnique({
    where: { id: SETTING_ID },
  });
  res.json(row ?? { id: SETTING_ID, ...DEFAULTS });
});

const updateSchema = zod.object({
  web_2fa_enabled: zod.boolean(),
});

// PUT /security_setting — 사이트 관리자가 2단계 인증을 켜고 끈다.
router.put(
  "/",
  siteAdminRequired,
  validateRequestBody(updateSchema),
  async (req, res) => {
    const data = req.body as zod.infer<typeof updateSchema>;
    const oldValue = await prisma.security_setting.findUnique({
      where: { id: SETTING_ID },
    });
    const updated = await prisma.security_setting.upsert({
      where: { id: SETTING_ID },
      update: data,
      create: { id: SETTING_ID, ...data },
    });
    await writeAuditLog({
      ...(await adminAuditContext(req)),
      tableName: "security_setting",
      action: "UPDATE",
      oldValue,
      newValue: updated,
    });
    console.log(
      `web 2fa ${updated.web_2fa_enabled ? "enabled" : "disabled"} by admin ${req.authSession!.user_id}`,
    );
    res.json(updated);
  },
);

export default router;
