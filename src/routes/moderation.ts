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

const TARGET_TYPES = ["post", "comment", "poll", "poll_comment", "review", "answer"] as const;
type TargetType = (typeof TARGET_TYPES)[number];

const REASONS = [
  "spam",
  "abuse",
  "sexual",
  "medical_misinfo",
  "privacy",
  "other",
] as const;

/** Public web build of the app — reported content is linkable there. */
const APP_WEB_ORIGIN = process.env.MYODOC_WEB_ORIGIN ?? "https://myodoc.co.kr";

/** What the admin queue needs to judge a report without guessing: a snippet of
 *  the content and a link that opens it. Comments resolve to their parent
 *  thread, since a comment has no page of its own. */
interface TargetContext {
  preview: string | null;
  url: string | null;
  /** Content already hidden (soft-deleted) — the admin may have nothing to do. */
  gone: boolean;
}

function snippet(s: string | null | undefined): string | null {
  if (s == null) return null;
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > 140 ? flat.slice(0, 140) + "…" : flat;
}

async function targetContext(type: TargetType, id: string): Promise<TargetContext> {
  switch (type) {
    case "post": {
      const r = await prisma.community_post.findUnique({ where: { id } });
      if (r == null) return { preview: null, url: null, gone: true };
      return {
        preview: snippet(`${r.title} — ${r.body}`),
        url: `${APP_WEB_ORIGIN}/community/${r.id}`,
        gone: r.deleted_at != null,
      };
    }
    case "comment": {
      const r = await prisma.community_comment.findUnique({ where: { id } });
      if (r == null) return { preview: null, url: null, gone: true };
      return {
        preview: snippet(r.body),
        // No page per comment — link the thread it lives in.
        url: `${APP_WEB_ORIGIN}/community/${r.post_id}`,
        gone: r.deleted_at != null,
      };
    }
    case "poll": {
      const r = await prisma.poll.findUnique({ where: { id } });
      if (r == null) return { preview: null, url: null, gone: true };
      return {
        preview: snippet(r.question),
        url: `${APP_WEB_ORIGIN}/community/poll/${r.id}`,
        gone: r.deleted_at != null,
      };
    }
    case "poll_comment": {
      const r = await prisma.poll_comment.findUnique({ where: { id } });
      if (r == null) return { preview: null, url: null, gone: true };
      return {
        preview: snippet(r.body),
        url: `${APP_WEB_ORIGIN}/community/poll/${r.poll_id}`,
        gone: r.deleted_at != null,
      };
    }
    case "answer": {
      // 시술/수술 질문에 병원이 단 답변(community_answer).
      const r = await prisma.community_answer.findUnique({ where: { id } });
      if (r == null) return { preview: null, url: null, gone: true };
      return {
        preview: snippet(r.body),
        url: `${APP_WEB_ORIGIN}/community/${r.post_id}`,
        gone: r.deleted_at != null,
      };
    }
    case "review": {
      const r = await prisma.hospital_review.findUnique({ where: { id } });
      if (r == null) return { preview: null, url: null, gone: true };
      return {
        preview: snippet(r.content),
        url: `${APP_WEB_ORIGIN}/treatment-finder/hospital?id=${encodeURIComponent(r.kakao_place_id)}`,
        gone: r.status !== "visible",
      };
    }
  }
}

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
    case "answer":
      // 작성자가 앱 회원이 아니라 병원 계정이다. 회원 단위 반복 신고 집계에는 넣지 않는다.
      return null;
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

/** GET /blocks — users the caller has blocked, newest first.
 *  Usernames come along so the manage screen can show who each row is; a list
 *  of bare uuids would be impossible to unblock from. */
router.get("/blocks", requireMobileAuth, async (req, res) => {
  const rows = await prisma.user_block.findMany({
    where: { blocker_user_id: req.mobileUser!.sub },
    orderBy: [{ created_at: "desc" }],
  });
  const names = new Map(
    (
      await prisma.user.findMany({
        where: { id: { in: rows.map((r) => r.blocked_user_id) } },
        select: { id: true, nickname: true },
      })
    ).map((r) => [r.id, r.nickname]),
  );
  res.json({
    blocked: rows.map((r) => ({
      userId: r.blocked_user_id,
      username: names.get(r.blocked_user_id) ?? null,
      createdAt: r.created_at.toISOString(),
    })),
  });
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
    await Promise.all(
      rows.map(async (r) => {
        const ctx = await targetContext(r.target_type as TargetType, r.target_id);
        return {
          id: r.id,
          targetType: r.target_type,
          targetId: r.target_id,
          reason: r.reason,
          detail: r.detail,
          status: r.status,
          createdAt: r.created_at.toISOString(),
          preview: ctx.preview,
          contentUrl: ctx.url,
          contentGone: ctx.gone,
        };
      }),
    ),
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
      case "answer":
        await prisma.community_answer.updateMany({ where: { id }, data: { deleted_at: now } });
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

/* ---- 커뮤니티 글 관리 (운영자) -----------------------------------------
 *
 * 신고가 들어온 것만이 아니라 전체 글을 훑고 지울 수 있어야 한다 - 테스트 글,
 * 광고처럼 아무도 신고하지 않는 것도 있다. 지우기는 앱의 삭제와 같이 숨김
 * (deleted_at)이라, 잘못 지웠으면 되살린다.
 * ----------------------------------------------------------------------- */

const ADMIN_PAGE_SIZE = 50;

/** GET /moderation/posts?q=&show=live|deleted|all&cursor= */
moderationAdminRouter.get("/posts", siteAdminRequired, async (req, res) => {
  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
  const show = req.query.show === "deleted" || req.query.show === "all" ? req.query.show : "live";
  const cursor = typeof req.query.cursor === "string" ? req.query.cursor : undefined;
  const rows = await prisma.community_post.findMany({
    where: {
      ...(show === "live" ? { deleted_at: null } : show === "deleted" ? { deleted_at: { not: null } } : {}),
      ...(q !== ""
        ? {
            OR: [
              { title: { contains: q, mode: "insensitive" } },
              { body: { contains: q, mode: "insensitive" } },
              { user: { nickname: { contains: q, mode: "insensitive" } } },
              { user: { email: { contains: q, mode: "insensitive" } } },
            ],
          }
        : {}),
    },
    orderBy: [{ created_at: "desc" }, { id: "desc" }],
    take: ADMIN_PAGE_SIZE + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    include: {
      user: { select: { nickname: true, email: true } },
      _count: {
        select: {
          comments: { where: { deleted_at: null } },
          answers: { where: { deleted_at: null } },
          likes: true,
        },
      },
    },
  });
  const page = rows.slice(0, ADMIN_PAGE_SIZE);
  res.json({
    posts: page.map((p) => ({
      id: p.id,
      title: p.title,
      bodyPreview: p.body.replace(/\s+/g, " ").slice(0, 200),
      category: p.category,
      imageCount: p.image_urls.length,
      authorId: p.user_id,
      authorNickname: p.user.nickname,
      authorEmail: p.user.email,
      createdAt: p.created_at.toISOString(),
      deleted: p.deleted_at != null,
      commentCount: p._count.comments,
      answerCount: p._count.answers,
      likeCount: p._count.likes,
      viewCount: p.view_count,
      url: `${APP_WEB_ORIGIN}/community/${p.id}`,
    })),
    nextCursor: rows.length > ADMIN_PAGE_SIZE ? page[page.length - 1].id : null,
  });
});

/** GET /moderation/posts/:id/comments — 지운 것까지 모두. */
moderationAdminRouter.get("/posts/:id/comments", siteAdminRequired, async (req, res) => {
  const rows = await prisma.community_comment.findMany({
    where: { post_id: String(req.params.id) },
    orderBy: { created_at: "asc" },
    include: { user: { select: { nickname: true } } },
  });
  res.json(
    rows.map((c) => ({
      id: c.id,
      parentCommentId: c.parent_comment_id,
      body: c.body,
      authorNickname: c.user.nickname,
      createdAt: c.created_at.toISOString(),
      deleted: c.deleted_at != null,
    })),
  );
});

/** GET /moderation/posts/:id/answers — 전문가 상담 글의 병원 답변, 숨긴 것까지. */
moderationAdminRouter.get("/posts/:id/answers", siteAdminRequired, async (req, res) => {
  const rows = await prisma.community_answer.findMany({
    where: { post_id: String(req.params.id) },
    orderBy: { created_at: "asc" },
    include: { account: { select: { hospital_name: true } } },
  });
  res.json(
    rows.map((a) => ({
      id: a.id,
      body: a.body,
      hospitalName: a.account.hospital_name,
      createdAt: a.created_at.toISOString(),
      deleted: a.deleted_at != null,
    })),
  );
});

/**
 * 숨기거나(deleted=true) 되살린다. 없는 id 면 404. 병원 답변은 숨긴 동안 병원이
 * 고쳐 쓸 수 없다(partnerQuestions.ts) - 운영자가 되살려야 다시 보인다.
 */
async function setDeleted(
  model: "post" | "comment" | "answer",
  id: string,
  deleted: boolean,
): Promise<boolean> {
  const data = { deleted_at: deleted ? new Date() : null };
  const r =
    model === "post"
      ? await prisma.community_post.updateMany({ where: { id }, data })
      : model === "comment"
        ? await prisma.community_comment.updateMany({ where: { id }, data })
        : await prisma.community_answer.updateMany({ where: { id }, data });
  return r.count > 0;
}

for (const model of ["post", "comment", "answer"] as const) {
  const base = `/${model}s/:id`;
  moderationAdminRouter.delete(base, siteAdminRequired, async (req, res) => {
    res.sendStatus((await setDeleted(model, String(req.params.id), true)) ? 204 : 404);
  });
  moderationAdminRouter.post(`${base}/restore`, siteAdminRequired, async (req, res) => {
    res.sendStatus((await setDeleted(model, String(req.params.id), false)) ? 204 : 404);
  });
}

export default router;
