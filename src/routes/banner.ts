import crypto from "crypto";
import fs from "fs";
import path from "path";
import express from "express";
import multer from "multer";
import zod from "zod";
import prisma from "../lib/prisma";
import { siteAdminRequired } from "../lib/middlewares";
import { validationMessage } from "../lib/validationError";

const router = express.Router();

// Banner images live on local disk (low volume — a handful of banners at a
// time — so no need for a separate GCS bucket). Persists across deploys since
// `uploads/` is gitignored, not part of the checked-out source tree.
const UPLOAD_DIR = path.join(__dirname, "../../uploads/banners");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Hardcoded like the other prod-domain references in this codebase
// (docs/nginx-security-headers.conf, myodoc's app.json `origin`) — there's no
// per-environment PUBLIC_ORIGIN config yet.
const PUBLIC_ORIGIN = "https://myopiamanage.org";

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, `${crypto.randomUUID()}${ext}`);
    },
  }),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (_req, file, cb) => {
    cb(null, /^image\//.test(file.mimetype));
  },
});

/**
 * 화면이 빈 칸을 "" 로 보낸다. 안 적은 것과 빈 글자는 같은 뜻이라 null 로
 * 바꿔 받는다 - 그대로 min(1) 에 걸리게 두면, 서브타이틀을 비웠다는
 * 이유로 배너가 저장되지 않는다.
 */
const optionalText = zod.preprocess(
  (v) => (typeof v === "string" && v.trim() === "" ? null : v),
  zod.string().min(1).nullable().optional(),
);

const createSchema = zod.object({
  title: zod.string().min(1, "제목을 적어 주세요."),
  subtitle: optionalText,
  badge_text: optionalText,
  image_url: zod.string().url("이미지를 올리거나 이미지 주소를 적어 주세요."),
  link_url: zod.string().url("연결 링크 주소를 적어 주세요."),
  placement: zod.string().min(1).optional(),
  sort_order: zod.number().int().optional(),
  active: zod.boolean().optional(),
  // 날짜도 비우면 "" 로 온다.
  start_at: zod.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? null : v),
    zod.string().datetime().nullable().optional(),
  ),
  end_at: zod.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? null : v),
    zod.string().datetime().nullable().optional(),
  ),
});
const patchSchema = createSchema.partial();

// POST /banner/upload — admin, multipart/form-data field "image".
// Returns { url } for use as image_url in create/update.
router.post("/upload", siteAdminRequired, upload.single("image"), (req, res) => {
  if (!req.file) {
    res.status(400).json({ message: "no image file (or not an image)" });
    return;
  }
  res.status(201).json({
    url: `${PUBLIC_ORIGIN}/api/banner/uploads/${req.file.filename}`,
  });
});

// GET /banner/uploads/:filename — public, serves uploaded banner images.
router.get("/uploads/:filename", (req, res) => {
  const filePath = path.join(UPLOAD_DIR, path.basename(req.params.filename));
  res.sendFile(filePath, (err) => {
    if (err) res.sendStatus(404);
  });
});

// GET /banner — admin list (includes inactive/expired).
router.get("/", siteAdminRequired, async (_req, res) => {
  const rows = await prisma.ad_banner.findMany({
    orderBy: [{ placement: "asc" }, { sort_order: "asc" }],
  });

  // 지난 30일 성적을 함께 낸다. 광고를 팔면 "몇 번 보였나"를 줘야 하는데,
  // 숫자를 보려고 다른 화면을 열게 하면 아무도 안 본다.
  const from = new Date();
  from.setUTCDate(from.getUTCDate() - 30);
  const stats = await prisma.banner_stat_daily.groupBy({
    by: ["banner_id"],
    where: { banner_id: { in: rows.map((r) => r.id) }, day: { gte: from } },
    _sum: { impressions: true, clicks: true },
  });
  const byId = new Map(stats.map((s) => [s.banner_id, s._sum]));
  res.json(
    rows.map((r) => ({
      ...r,
      impressions30d: byId.get(r.id)?.impressions ?? 0,
      clicks30d: byId.get(r.id)?.clicks ?? 0,
    })),
  );
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
    res.status(400).json({ message: validationMessage(parsed.error) });
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
    res.status(400).json({ message: validationMessage(parsed.error) });
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
