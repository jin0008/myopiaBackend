import express from "express";
import zod from "zod";
import prisma from "../lib/prisma";
import { requireMobileAuth } from "../lib/mobileAuth";
import { siteAdminRequired } from "../lib/middlewares";
import { PrismaClientKnownRequestError } from "@prisma/client/runtime/library";

/** Mounted under /api/mobile — app users report and block. */
const router = express.Router();
/** Mounted under /moderation — site admins work the report queue with their
 *  doctor-platform session, so it can't share the mobile-auth prefix. */
export const moderationAdminRouter = express.Router();

const TARGET_TYPES = ["post", "comment", "poll", "poll_comment", "review"] as const;
type TargetType = (typeof TARGET_TYPES)[number];

const REASONS = [
  "spam",
  "abuse",
  "sexual",
  "medical_misinfo",
  "privacy",
  "other",
] as const;

/** Look up the author of the reported content so admins can see repeat
 *  offenders. Returns null when the target no longer exists. */
async function targetAuthorId(type: TargetType, id: string): Promise<string | null> {
  switch (type) {
    case "post": {
      const r = await prisma.community_post.findUnique({
        where: { id },
        select: { user_id: true },
      });
      return r?.user_id ?? null;
    }
    case "comment": {
      const r = await prisma.community_comment.findUnique({
        where: { id },
        select: { user_id: true },
      });
      return r?.user_id ?? null;
    }
    case "poll": {
      const r = await prisma.poll.findUnique({ where: { id }, select: { user_id: true } });
      return r?.user_id ?? null;
    }
    case "poll_comment": {
      const r = await prisma.poll_comment.findUnique({
        where: { id },
        select: { user_id: true },
      });
      return r?.user_id ?? null;
    }
    case "review": {
      const r = await prisma.hospital_review.findUnique({
        where: { id },
        select: { user_id: true },
      });
      return r?.user_id ?? null;
    }
  }
}

/* ---- reporting --------------------------------------------------------- */

const reportSchema = zod.object({
  targetType: zod.enum(TARGET_TYPES),
  targetId: zod.string().min(1),
  reason: zod.enum(REASONS),
  detail: zod.string().trim().max(1000).optional(),
});

/** POST /reports — report a piece of content. Idempotent per reporter. */
router.post("/reports", requireMobileAuth, async (req, res) => {
  const parsed = reportSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid body", code: "bad_request" });
    return;
  }
  const { targetType, targetId, reason, detail } = parsed.data;
  const authorId = await targetAuthorId(targetType, targetId);
  if (authorId == null) {
    res.status(404).json({ error: "content not found", code: "not_found" });
    return;
  }
  try {
    await prisma.content_report.create({
      data: {
        reporter_user_id: req.mobileUser!.sub,
        target_type: targetType,
        target_id: targetId,
        target_user_id: authorId,
        reason,
        detail,
      },
    });
  } catch (e) {
    // Already reported by this user — treat as success so the UI stays simple.
    if (!(e instanceof PrismaClientKnownRequestError && e.code === "P2002")) throw e;
  }
  res.status(201).json({ ok: true });
});

/* ---- blocking ---------------------------------------------------------- */

/** GET /blocks — ids the caller has blocked. */
router.get("/blocks", requireMobileAuth, async (req, res) => {
  const rows = await prisma.user_block.findMany({
    where: { blocker_user_id: req.mobileUser!.sub },
    select: { blocked_user_id: true },
  });
  res.json({ blockedUserIds: rows.map((r) => r.blocked_user_id) });
});

/** POST /blocks/:userId — hide this user's content from the caller. */
router.post("/blocks/:userId", requireMobileAuth, async (req, res) => {
  const me = req.mobileUser!.sub;
  const target = String(req.params.userId);
  if (target === me) {
    res.status(400).json({ error: "cannot block yourself", code: "bad_request" });
    return;
  }
  const exists = await prisma.user.findUnique({ where: { id: target }, select: { id: true } });
  if (exists == null) {
    res.status(404).json({ error: "user not found", code: "not_found" });
    return;
  }
  try {
    await prisma.user_block.create({
      data: { blocker_user_id: me, blocked_user_id: target },
    });
  } catch (e) {
    if (!(e instanceof PrismaClientKnownRequestError && e.code === "P2002")) throw e;
  }
  res.status(201).json({ blocked: true });
});

/** DELETE /blocks/:userId — unblock. */
router.delete("/blocks/:userId", requireMobileAuth, async (req, res) => {
  await prisma.user_block.deleteMany({
    where: { blocker_user_id: req.mobileUser!.sub, blocked_user_id: String(req.params.userId) },
  });
  res.json({ blocked: false });
});

/* ---- admin ------------------------------------------------------------- */

/** GET /moderation/reports?status= — site-admin review queue. */
moderationAdminRouter.get("/reports", siteAdminRequired, async (req, res) => {
  const status = typeof req.query.status === "string" ? req.query.status : "pending";
  const rows = await prisma.content_report.findMany({
    where: status === "all" ? {} : { status },
    orderBy: [{ created_at: "desc" }],
    take: 200,
  });
  res.json(
    rows.map((r) => ({
      id: r.id,
      targetType: r.target_type,
      targetId: r.target_id,
      reason: r.reason,
      detail: r.detail,
      status: r.status,
      createdAt: r.created_at.toISOString(),
    })),
  );
});

const resolveSchema = zod.object({
  status: zod.enum(["pending", "resolved", "dismissed"]),
  /** When true, also soft-delete/hide the reported content. */
  hideContent: zod.boolean().optional(),
});

/** PATCH /moderation/reports/:id — resolve a report, optionally hiding the content. */
moderationAdminRouter.patch("/reports/:id", siteAdminRequired, async (req, res) => {
  const parsed = resolveSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "invalid body" });
    return;
  }
  const report = await prisma.content_report.findUnique({
    where: { id: String(req.params.id) },
  });
  if (report == null) {
    res.sendStatus(404);
    return;
  }
  if (parsed.data.hideContent) {
    const now = new Date();
    const id = report.target_id;
    switch (report.target_type) {
      case "post":
        await prisma.community_post.updateMany({ where: { id }, data: { deleted_at: now } });
        break;
      case "comment":
        await prisma.community_comment.updateMany({ where: { id }, data: { deleted_at: now } });
        break;
      case "poll":
        await prisma.poll.updateMany({ where: { id }, data: { deleted_at: now } });
        break;
      case "poll_comment":
        await prisma.poll_comment.updateMany({ where: { id }, data: { deleted_at: now } });
        break;
      case "review":
        await prisma.hospital_review.updateMany({ where: { id }, data: { status: "hidden" } });
        break;
    }
  }
  const updated = await prisma.content_report.update({
    where: { id: report.id },
    data: { status: parsed.data.status, updated_at: new Date() },
  });
  res.json({ id: updated.id, status: updated.status });
});

export default router;
