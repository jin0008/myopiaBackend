import express from "express";
import zod from "zod";
import prisma from "../lib/prisma";
import { siteAdminRequired } from "../lib/middlewares";

const router = express.Router();

const createSchema = zod.object({
  title: zod.string().min(1),
  body: zod.string().min(1),
  category: zod.string().min(1),
  author: zod.string().min(1).optional(),
  author_role: zod.string().min(1).optional(),
  thumbnail_emoji: zod.string().min(1).optional(),
  published: zod.boolean().optional(),
});
const patchSchema = createSchema.partial();

// GET /column — admin list (includes unpublished).
router.get("/", siteAdminRequired, async (_req, res) => {
  const rows = await prisma.expert_column.findMany({
    orderBy: [{ published_at: "desc" }],
  });
  res.json(rows);
});

// GET /column/:id — single (for the edit form).
router.get("/:id", siteAdminRequired, async (req, res) => {
  const row = await prisma.expert_column.findUnique({
    where: { id: String(req.params.id) },
  });
  if (row == null) {
    res.sendStatus(404);
    return;
  }
  res.json(row);
});

// POST /column — create.
router.post("/", siteAdminRequired, async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "invalid body" });
    return;
  }
  const d = parsed.data;
  const slug =
    "col_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const row = await prisma.expert_column.create({
    data: {
      slug,
      title: d.title,
      body: d.body,
      category: d.category,
      author: d.author ?? "마이오닥 의료진",
      author_role: d.author_role ?? "안과 감수",
      thumbnail_emoji: d.thumbnail_emoji ?? "📄",
      published: d.published ?? true,
      created_by: req.authSession!.user_id,
    },
  });
  res.status(201).json(row);
});

// PATCH /column/:id — edit.
router.patch("/:id", siteAdminRequired, async (req, res) => {
  const parsed = patchSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "invalid body" });
    return;
  }
  const row = await prisma.expert_column
    .update({
      where: { id: String(req.params.id) },
      data: { ...parsed.data, updated_at: new Date() },
    })
    .catch(() => null);
  if (row == null) {
    res.sendStatus(404);
    return;
  }
  res.json(row);
});

// DELETE /column/:id — remove.
router.delete("/:id", siteAdminRequired, async (req, res) => {
  await prisma.expert_column
    .delete({ where: { id: String(req.params.id) } })
    .catch(() => {});
  res.sendStatus(204);
});

export default router;
