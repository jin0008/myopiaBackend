import express from "express";
import prisma from "../lib/prisma";
import { requireMobileAuth } from "../lib/mobileAuth";

const router = express.Router();

/** GET /notifications — newest first, with the unread count for the badge. */
router.get("/notifications", requireMobileAuth, async (req, res) => {
  const userId = req.mobileUser!.sub;
  const [rows, unreadCount] = await Promise.all([
    prisma.notification.findMany({
      where: { user_id: userId },
      orderBy: [{ created_at: "desc" }],
      take: 100,
    }),
    prisma.notification.count({ where: { user_id: userId, read_at: null } }),
  ]);

  // Resolve actor names in one query rather than per row.
  const actorIds = [...new Set(rows.map((r) => r.actor_user_id).filter((x): x is string => x != null))];
  const names = new Map(
    (
      await prisma.password_auth.findMany({
        where: { user_id: { in: actorIds } },
        select: { user_id: true, username: true },
      })
    ).map((r) => [r.user_id, r.username]),
  );

  res.json({
    unreadCount,
    notifications: rows.map((r) => ({
      id: r.id,
      type: r.type,
      actorName: r.actor_user_id == null ? null : names.get(r.actor_user_id) ?? null,
      targetType: r.target_type,
      targetId: r.target_id,
      title: r.title,
      preview: r.preview,
      read: r.read_at != null,
      createdAt: r.created_at.toISOString(),
    })),
  });
});

/** GET /notifications/unread-count — cheap poll for the header badge. */
router.get("/notifications/unread-count", requireMobileAuth, async (req, res) => {
  const unreadCount = await prisma.notification.count({
    where: { user_id: req.mobileUser!.sub, read_at: null },
  });
  res.json({ unreadCount });
});

/** POST /notifications/read — mark all (or one) as read. */
router.post("/notifications/read", requireMobileAuth, async (req, res) => {
  const id = typeof req.body?.id === "string" ? req.body.id : null;
  await prisma.notification.updateMany({
    where: {
      user_id: req.mobileUser!.sub,
      read_at: null,
      ...(id != null && { id }),
    },
    data: { read_at: new Date() },
  });
  res.json({ ok: true });
});

export default router;
