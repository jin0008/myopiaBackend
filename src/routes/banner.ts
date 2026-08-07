import express from "express";
import zod from "zod";
import prisma from "../lib/prisma";
import { siteAdminRequired } from "../lib/middlewares";

const router = express.Router();

const createSchema = zod.object({
  title: zod.string().min(1),
  subtitle: zod.string().min(1).optional(),
  badge_text: zod.string().min(1).optional(),
  image_url: zod.string().url(),
  link_url: zod.string().url(),
  placement: zod.string().min(1).optional(),
  sort_order: zod.number().int().optional(),
  active: zod.boolean().optional(),
  start_at: zod.string().datetime().nullable().optional(),
  end_at: zod.string().datetime().nullable().optional(),
});
const patchSchema = createSchema.partial();

// GET /banner — admin list (includes inactive/expired).
router.get("/", siteAdminRequired, async (_req, res) => {
  const rows = await prisma.ad_banner.findMany({
    orderBy: [{ placement: "asc" }, { sort_order: "asc" }],
  });
  res.json(rows);
});

// GET /banner/:id — single (for the edit form).
router.get("/:id", siteAdminRequired, async (req, res) => {
  const row = await prisma.ad_banner.findUnique({
    where: { id: String(req.params.id) },
  });
  if (row == null) {
    res.sendStatus(404);
    return;
  }
  res.json(row);
});

// POST /banner — create.
router.post("/", siteAdminRequired, async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "invalid body" });
    return;
  }
  const d = parsed.data;
  const row = await prisma.ad_banner.create({
    data: {
      title: d.title,
      subtitle: d.subtitle,
      badge_text: d.badge_text,
      image_url: d.image_url,
      link_url: d.link_url,
      placement: d.placement ?? "home",
      sort_order: d.sort_order ?? 0,
      active: d.active ?? true,
      start_at: d.start_at ? new Date(d.start_at) : null,
      end_at: d.end_at ? new Date(d.end_at) : null,
      created_by: req.authSession!.user_id,
    },
  });
  res.status(201).json(row);
});

// PATCH /banner/:id — edit.
router.patch("/:id", siteAdminRequired, async (req, res) => {
  const parsed = patchSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "invalid body" });
    return;
  }
  const { start_at, end_at, ...rest } = parsed.data;
  const row = await prisma.ad_banner
    .update({
      where: { id: String(req.params.id) },
      data: {
        ...rest,
        ...(start_at !== undefined && { start_at: start_at ? new Date(start_at) : null }),
        ...(end_at !== undefined && { end_at: end_at ? new Date(end_at) : null }),
        updated_at: new Date(),
      },
    })
    .catch(() => null);
  if (row == null) {
    res.sendStatus(404);
    return;
  }
  res.json(row);
});

// DELETE /banner/:id — remove.
router.delete("/:id", siteAdminRequired, async (req, res) => {
  await prisma.ad_banner
    .delete({ where: { id: String(req.params.id) } })
    .catch(() => {});
  res.sendStatus(204);
});

export default router;
