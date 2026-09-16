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

/* ---- 폰 알림 ------------------------------------------------------------
 *
 * 토큰 등록과 설정. 보내는 쪽은 lib/push.ts 와 크론이 맡는다.
 */

/**
 * PUT /notifications/push-token — 이 기기로 보내 달라.
 *
 * 앱이 켜질 때마다 부른다. 토큰은 OS 가 바꿀 수 있고, 기기를 물려주거나
 * 한 폰에서 계정을 바꿔 로그인하면 같은 토큰이 다른 사람 것이 된다.
 * 그래서 토큰을 유일하게 두고, 다시 등록되면 주인을 바꾼다.
 */
router.put("/notifications/push-token", requireMobileAuth, async (req, res) => {
  const userId = req.mobileUser!.sub;
  const token = String(req.body?.token ?? "").trim();
  const platform =
    req.body?.platform === "ios" || req.body?.platform === "android"
      ? req.body.platform
      : null;
  if (!/^Expo(nent)?PushToken\[[^\]]+\]$/.test(token)) {
    res.status(400).json({ error: "bad token", code: "bad_request" });
    return;
  }
  await prisma.push_token.upsert({
    where: { token },
    create: { user_id: userId, token, platform },
    update: { user_id: userId, platform, last_seen_at: new Date() },
  });
  res.sendStatus(204);
});

/**
 * DELETE /notifications/push-token — 이 기기로는 그만.
 *
 * 로그아웃할 때 부른다. 안 지우면 다음 사람이 이 폰으로 로그인하기 전까지
 * 앞사람의 알림이 이 기기로 온다.
 */
router.delete("/notifications/push-token", requireMobileAuth, async (req, res) => {
  const userId = req.mobileUser!.sub;
  const token = String(req.body?.token ?? req.query.token ?? "").trim();
  if (token === "") {
    res.status(400).json({ error: "token required", code: "bad_request" });
    return;
  }
  // 남의 토큰을 지우지 못하게 사용자도 함께 건다.
  await prisma.push_token.deleteMany({ where: { token, user_id: userId } });
  res.sendStatus(204);
});

/** 줄이 없으면 전부 받는 것이 기본이다. 화면도 같은 값을 봐야 한다. */
const PREF_DEFAULT = { community: true, careDaily: true, careHour: 21, reminder: true };

router.get("/notifications/prefs", requireMobileAuth, async (req, res) => {
  const userId = req.mobileUser!.sub;
  const p = await prisma.notification_pref.findUnique({ where: { user_id: userId } });
  res.json(
    p == null
      ? PREF_DEFAULT
      : {
          community: p.community,
          careDaily: p.care_daily,
          careHour: p.care_hour,
          reminder: p.reminder,
        },
  );
});

router.put("/notifications/prefs", requireMobileAuth, async (req, res) => {
  const userId = req.mobileUser!.sub;
  const b = req.body ?? {};
  const bool = (v: unknown, fallback: boolean) => (typeof v === "boolean" ? v : fallback);
  // 정시만 받는다. 분까지 열어 두면 크론이 매분 돌아야 한다.
  const hour = Number.isInteger(b.careHour) ? Math.min(Math.max(b.careHour, 0), 23) : 21;

  const data = {
    community: bool(b.community, true),
    care_daily: bool(b.careDaily, true),
    care_hour: hour,
    reminder: bool(b.reminder, true),
    updated_at: new Date(),
  };
  const p = await prisma.notification_pref.upsert({
    where: { user_id: userId },
    create: { user_id: userId, ...data },
    update: data,
  });
  res.json({
    community: p.community,
    careDaily: p.care_daily,
    careHour: p.care_hour,
    reminder: p.reminder,
  });
});
