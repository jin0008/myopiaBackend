import express from "express";
import zod from "zod";
import prisma from "../lib/prisma";
import { requireMobileAuth, optionalMobileAuth } from "../lib/mobileAuth";
import { PrismaClientKnownRequestError } from "@prisma/client/runtime/library";
import { authorBlockFilter } from "../lib/blocks";

const router = express.Router();

const NO_VIEWER = "00000000-0000-0000-0000-000000000000";
const COMMENT_PAGE_SIZE = 200;

/** Resolve display usernames for a set of user ids in one query. */
async function usernameMap(userIds: string[]): Promise<Map<string, string | null>> {
  const unique = [...new Set(userIds)];
  if (unique.length === 0) return new Map();
  const rows = await prisma.password_auth.findMany({
    where: { user_id: { in: unique } },
    select: { user_id: true, username: true },
  });
  return new Map(rows.map((r) => [r.user_id, r.username]));
}

/* ---- polls ------------------------------------------------------------- */

const createPollSchema = zod.object({
  question: zod.string().trim().min(1).max(300),
  options: zod.array(zod.string().trim().min(1).max(120)).min(2).max(6),
  closesAt: zod.string().datetime().nullable().optional(),
});

/** GET /polls?status=open|closed&cursor=<id> — list newest first. */
router.get("/polls", optionalMobileAuth, async (req, res) => {
  const viewerId = req.mobileUser?.sub ?? NO_VIEWER;
  const status = req.query.status === "closed" ? "closed" : req.query.status === "open" ? "open" : null;
  const now = new Date();
  const closesFilter =
    status === "open"
      ? { OR: [{ closes_at: null }, { closes_at: { gt: now } }] }
      : status === "closed"
        ? { closes_at: { lte: now } }
        : {};

  const notBlocked = await authorBlockFilter(req.mobileUser?.sub);
  const polls = await prisma.poll.findMany({
    where: { deleted_at: null, ...notBlocked, ...closesFilter },
    orderBy: [{ created_at: "desc" }],
    take: 30,
    include: {
      options: { orderBy: { position: "asc" } },
      // Soft-deleted comments must not inflate the count (same as community).
      _count: { select: { votes: true, comments: { where: { deleted_at: null } } } },
      votes: { where: { user_id: viewerId }, take: 1 },
    },
  });

  // Per-option tallies for every listed poll in one query, so the list cards
  // can render results (똑닥-style) without an extra round-trip per poll.
  const tallies = await prisma.poll_vote.groupBy({
    by: ["option_id"],
    where: { poll_id: { in: polls.map((p) => p.id) } },
    _count: { _all: true },
  });
  const countByOption = new Map(tallies.map((t) => [t.option_id, t._count._all]));

  res.json({
    polls: polls.map((p) => {
      const total = p._count.votes;
      return {
        id: p.id,
        question: p.question,
        closesAt: p.closes_at?.toISOString() ?? null,
        closed: p.closes_at != null && p.closes_at <= now,
        optionCount: p.options.length,
        totalVotes: total,
        commentCount: p._count.comments,
        votedByMe: p.votes.length > 0,
        myOptionId: p.votes[0]?.option_id ?? null,
        createdAt: p.created_at.toISOString(),
        options: p.options.map((o) => {
          const count = countByOption.get(o.id) ?? 0;
          return {
            id: o.id,
            label: o.label,
            count,
            percent: total > 0 ? Math.round((count / total) * 100) : 0,
          };
        }),
      };
    }),
  });
});

/** POST /polls — any logged-in user can create a poll. */
router.post("/polls", requireMobileAuth, async (req, res) => {
  const parsed = createPollSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid body", code: "bad_request" });
    return;
  }
  const { question, options, closesAt } = parsed.data;
  const poll = await prisma.poll.create({
    data: {
      user_id: req.mobileUser!.sub,
      question,
      closes_at: closesAt ? new Date(closesAt) : null,
      options: {
        create: options.map((label, i) => ({ label, position: i })),
      },
    },
  });
  res.status(201).json({ id: poll.id });
});

/** GET /polls/:id — options with vote counts/percent + my vote. */
router.get("/polls/:id", optionalMobileAuth, async (req, res) => {
  const viewerId = req.mobileUser?.sub ?? NO_VIEWER;
  const id = String(req.params.id);
  const poll = await prisma.poll.findFirst({
    where: { id, deleted_at: null },
    include: {
      options: { orderBy: { position: "asc" } },
      _count: { select: { comments: { where: { deleted_at: null } } } },
    },
  });
  if (poll == null) {
    res.status(404).json({ error: "poll not found", code: "not_found" });
    return;
  }
  const counts = await prisma.poll_vote.groupBy({
    by: ["option_id"],
    where: { poll_id: id },
    _count: { _all: true },
  });
  const countByOption = new Map(counts.map((c) => [c.option_id, c._count._all]));
  const total = counts.reduce((sum, c) => sum + c._count._all, 0);
  const myVote = await prisma.poll_vote.findUnique({
    where: { user_id_poll_id: { user_id: viewerId, poll_id: id } },
  });
  const now = new Date();
  const author = (await usernameMap([poll.user_id])).get(poll.user_id) ?? null;

  res.json({
    id: poll.id,
    question: poll.question,
    authorName: author,
    authorId: poll.user_id,
    isMine: poll.user_id === viewerId,
    closesAt: poll.closes_at?.toISOString() ?? null,
    closed: poll.closes_at != null && poll.closes_at <= now,
    totalVotes: total,
    commentCount: poll._count.comments,
    myOptionId: myVote?.option_id ?? null,
    createdAt: poll.created_at.toISOString(),
    options: poll.options.map((o) => {
      const count = countByOption.get(o.id) ?? 0;
      return {
        id: o.id,
        label: o.label,
        count,
        percent: total > 0 ? Math.round((count / total) * 100) : 0,
      };
    }),
  });
});

/** POST /polls/:id/vote — one vote per user; locked once cast. */
router.post("/polls/:id/vote", requireMobileAuth, async (req, res) => {
  const userId = req.mobileUser!.sub;
  const pollId = String(req.params.id);
  const optionId = typeof req.body?.optionId === "string" ? req.body.optionId : "";

  const poll = await prisma.poll.findFirst({ where: { id: pollId, deleted_at: null } });
  if (poll == null) {
    res.status(404).json({ error: "poll not found", code: "not_found" });
    return;
  }
  if (poll.closes_at != null && poll.closes_at <= new Date()) {
    res.status(409).json({ error: "poll closed", code: "closed" });
    return;
  }
  const option = await prisma.poll_option.findFirst({
    where: { id: optionId, poll_id: pollId },
  });
  if (option == null) {
    res.status(400).json({ error: "invalid option", code: "bad_request" });
    return;
  }
  try {
    await prisma.poll_vote.create({
      data: { user_id: userId, poll_id: pollId, option_id: optionId },
    });
  } catch (e) {
    if (e instanceof PrismaClientKnownRequestError && e.code === "P2002") {
      res.status(409).json({ error: "already voted", code: "duplicate" });
      return;
    }
    throw e;
  }
  res.status(201).json({ ok: true });
});

/** DELETE /polls/:id — soft-delete; author only. */
router.delete("/polls/:id", requireMobileAuth, async (req, res) => {
  const userId = req.mobileUser!.sub;
  const poll = await prisma.poll.findFirst({
    where: { id: String(req.params.id), deleted_at: null },
  });
  if (poll == null) {
    res.status(404).json({ error: "poll not found", code: "not_found" });
    return;
  }
  if (poll.user_id !== userId) {
    res.status(403).json({ error: "not your poll", code: "forbidden" });
    return;
  }
  await prisma.poll.update({ where: { id: poll.id }, data: { deleted_at: new Date() } });
  res.json({ ok: true });
});

/* ---- poll comments (nested one level, with likes) ---------------------- */

const createCommentSchema = zod.object({
  body: zod.string().trim().min(1).max(5000),
  parentCommentId: zod.string().uuid().nullable().optional(),
});

/** GET /polls/:id/comments — flat list; client rebuilds the reply tree. */
router.get("/polls/:id/comments", optionalMobileAuth, async (req, res) => {
  const viewerId = req.mobileUser?.sub ?? NO_VIEWER;
  const pollId = String(req.params.id);
  const exists = await prisma.poll.findFirst({
    where: { id: pollId, deleted_at: null },
    select: { id: true },
  });
  if (exists == null) {
    res.status(404).json({ error: "poll not found", code: "not_found" });
    return;
  }
  const notBlocked = await authorBlockFilter(req.mobileUser?.sub);
  const rows = await prisma.poll_comment.findMany({
    where: { poll_id: pollId, ...notBlocked },
    orderBy: [{ created_at: "asc" }, { id: "asc" }],
    take: COMMENT_PAGE_SIZE,
    include: {
      _count: { select: { likes: true } },
      likes: { where: { user_id: viewerId }, take: 1 },
    },
  });
  const names = await usernameMap(rows.map((r) => r.user_id));
  res.json({
    comments: rows.map((c) => ({
      id: c.id,
      pollId: c.poll_id,
      parentCommentId: c.parent_comment_id,
      body: c.deleted_at != null ? null : c.body,
      deleted: c.deleted_at != null,
      author: {
        id: c.user_id,
        username: names.get(c.user_id) ?? null,
        isMe: c.user_id === viewerId,
      },
      createdAt: c.created_at.toISOString(),
      likeCount: c._count.likes,
      likedByMe: c.likes.length > 0,
    })),
  });
});

/** POST /polls/:id/comments — reply via parentCommentId (flattened one level). */
router.post("/polls/:id/comments", requireMobileAuth, async (req, res) => {
  const userId = req.mobileUser!.sub;
  const pollId = String(req.params.id);
  const parsed = createCommentSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid body", code: "bad_request" });
    return;
  }
  const poll = await prisma.poll.findFirst({
    where: { id: pollId, deleted_at: null },
    select: { id: true },
  });
  if (poll == null) {
    res.status(404).json({ error: "poll not found", code: "not_found" });
    return;
  }
  const { body, parentCommentId } = parsed.data;
  let resolvedParentId: string | null = null;
  if (parentCommentId != null) {
    const parent = await prisma.poll_comment.findUnique({ where: { id: parentCommentId } });
    if (parent == null || parent.poll_id !== pollId || parent.deleted_at != null) {
      res.status(400).json({ error: "invalid parentCommentId", code: "bad_request" });
      return;
    }
    resolvedParentId = parent.parent_comment_id ?? parent.id;
  }
  const comment = await prisma.poll_comment.create({
    data: { poll_id: pollId, user_id: userId, parent_comment_id: resolvedParentId, body },
  });
  const names = await usernameMap([userId]);
  res.status(201).json({
    id: comment.id,
    pollId: comment.poll_id,
    parentCommentId: comment.parent_comment_id,
    body: comment.body,
    deleted: false,
    author: { id: userId, username: names.get(userId) ?? null, isMe: true },
    createdAt: comment.created_at.toISOString(),
    likeCount: 0,
    likedByMe: false,
  });
});

/** PATCH /polls/comments/:id — author only. */
router.patch("/polls/comments/:id", requireMobileAuth, async (req, res) => {
  const parsed = zod
    .object({ body: zod.string().trim().min(1).max(5_000) })
    .safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid body", code: "bad_request" });
    return;
  }
  const userId = req.mobileUser!.sub;
  const comment = await prisma.poll_comment.findUnique({ where: { id: String(req.params.id) } });
  if (comment == null || comment.deleted_at != null) {
    res.status(404).json({ error: "comment not found", code: "not_found" });
    return;
  }
  if (comment.user_id !== userId) {
    res.status(403).json({ error: "not your comment", code: "forbidden" });
    return;
  }
  const updated = await prisma.poll_comment.update({
    where: { id: comment.id },
    data: { body: parsed.data.body },
  });
  res.json({ id: updated.id, body: updated.body });
});

/** DELETE /polls/comments/:id — soft-delete; author only. */
router.delete("/polls/comments/:id", requireMobileAuth, async (req, res) => {
  const userId = req.mobileUser!.sub;
  const comment = await prisma.poll_comment.findUnique({ where: { id: String(req.params.id) } });
  if (comment == null || comment.deleted_at != null) {
    res.status(404).json({ error: "comment not found", code: "not_found" });
    return;
  }
  if (comment.user_id !== userId) {
    res.status(403).json({ error: "not your comment", code: "forbidden" });
    return;
  }
  await prisma.poll_comment.update({
    where: { id: comment.id },
    data: { deleted_at: new Date() },
  });
  res.json({ ok: true });
});

/** POST /polls/comments/:id/like — idempotent (공감). */
router.post("/polls/comments/:id/like", requireMobileAuth, async (req, res) => {
  const userId = req.mobileUser!.sub;
  const commentId = String(req.params.id);
  const comment = await prisma.poll_comment.findFirst({
    where: { id: commentId, deleted_at: null },
    select: { id: true },
  });
  if (comment == null) {
    res.status(404).json({ error: "comment not found", code: "not_found" });
    return;
  }
  try {
    await prisma.poll_comment_like.create({ data: { comment_id: commentId, user_id: userId } });
  } catch (e) {
    if (!(e instanceof PrismaClientKnownRequestError && e.code === "P2002")) throw e;
  }
  const likeCount = await prisma.poll_comment_like.count({ where: { comment_id: commentId } });
  res.json({ liked: true, likeCount });
});

/** DELETE /polls/comments/:id/like — idempotent. */
router.delete("/polls/comments/:id/like", requireMobileAuth, async (req, res) => {
  const userId = req.mobileUser!.sub;
  const commentId = String(req.params.id);
  await prisma.poll_comment_like.deleteMany({
    where: { comment_id: commentId, user_id: userId },
  });
  const likeCount = await prisma.poll_comment_like.count({ where: { comment_id: commentId } });
  res.json({ liked: false, likeCount });
});

export default router;
