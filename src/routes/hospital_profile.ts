import crypto from "crypto";
import fs from "fs";
import path from "path";
import express from "express";
import multer from "multer";
import zod from "zod";
import prisma from "../lib/prisma";
import { siteAdminRequired } from "../lib/middlewares";

const router = express.Router();

// Same local-disk approach as banner images (low volume, no GCS needed).
const UPLOAD_DIR = path.join(__dirname, "../../uploads/hospital-profiles");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const PUBLIC_ORIGIN = "https://myopiamanage.org";

// Raster extensions only — mimetype is spoofable and these are served back by
// extension, so allowing .svg/.html would enable stored XSS.
const ALLOWED_EXT = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif"]);

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, `${crypto.randomUUID()}${ext}`);
    },
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, /^image\//.test(file.mimetype) && ALLOWED_EXT.has(ext));
  },
});

const STATUSES = ["draft", "pending", "published"] as const;

const treatmentItemSchema = zod.object({
  category: zod.string().min(1),
  name: zod.string().min(1),
  normalPrice: zod.number().nullable().optional(),
  eventPrice: zod.number().nullable().optional(),
  description: zod.string().optional(),
});

const createSchema = zod.object({
  kakao_place_id: zod.string().min(1),
  name: zod.string().min(1),
  description: zod.string().optional(),
  banner_image_url: zod.string().url().nullable().optional(),
  images: zod.array(zod.string().url()).optional(),
  phone: zod.string().optional(),
  address: zod.string().optional(),
  status: zod.enum(STATUSES).optional(),
  hospital_id: zod.string().uuid().nullable().optional(),
  thumbnail_url: zod.string().url().nullable().optional(),
  keywords: zod.array(zod.string()).optional(),
  treatment_items: zod.array(treatmentItemSchema).optional(),
  verified: zod.boolean().optional(),
  booking_url: zod.string().url().nullable().optional(),
});
const patchSchema = createSchema.partial();

// POST /hospital-profile/upload — admin image upload, returns { url }.
router.post("/upload", siteAdminRequired, upload.single("image"), (req, res) => {
  if (!req.file) {
    res.status(400).json({ message: "no image file (or not an image)" });
    return;
  }
  res.status(201).json({
    url: `${PUBLIC_ORIGIN}/api/hospital-profile/uploads/${req.file.filename}`,
  });
});

// GET /hospital-profile/uploads/:filename — public, serves uploaded images.
router.get("/uploads/:filename", (req, res) => {
  const filePath = path.join(UPLOAD_DIR, path.basename(req.params.filename));
  res.sendFile(filePath, (err) => {
    if (err) res.sendStatus(404);
  });
});

/* ---- review moderation (site admin) ----------------------------------- *
 * Under /moderation/* so it never collides with the /:id profile routes. */

// GET /hospital-profile/moderation/:kakaoPlaceId/reviews — all statuses.
router.get("/moderation/:kakaoPlaceId/reviews", siteAdminRequired, async (req, res) => {
  const rows = await prisma.hospital_review.findMany({
    where: { kakao_place_id: String(req.params.kakaoPlaceId) },
    orderBy: [{ created_at: "desc" }],
  });
  res.json(rows);
});

// PATCH /hospital-profile/moderation/reviews/:id — hide/unhide a review.
const moderateSchema = zod.object({ status: zod.enum(["visible", "hidden"]) });
router.patch("/moderation/reviews/:id", siteAdminRequired, async (req, res) => {
  const parsed = moderateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "invalid body" });
    return;
  }
  const row = await prisma.hospital_review
    .update({
      where: { id: String(req.params.id) },
      data: { status: parsed.data.status, updated_at: new Date() },
    })
    .catch(() => null);
  if (row == null) {
    res.sendStatus(404);
    return;
  }
  res.json({ id: row.id, status: row.status });
});

// GET /hospital-profile — admin list (all statuses).
router.get("/", siteAdminRequired, async (_req, res) => {
  const rows = await prisma.hospital_profile.findMany({
    orderBy: [{ updated_at: "desc" }],
  });
  res.json(rows);
});

// GET /hospital-profile/:id — single (for the edit form).
router.get("/:id", siteAdminRequired, async (req, res) => {
  const row = await prisma.hospital_profile.findUnique({
    where: { id: String(req.params.id) },
  });
  if (row == null) {
    res.sendStatus(404);
    return;
  }
  res.json(row);
});

// POST /hospital-profile — create.
router.post("/", siteAdminRequired, async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "invalid body" });
    return;
  }
  const d = parsed.data;
  const row = await prisma.hospital_profile
    .create({
      data: {
        kakao_place_id: d.kakao_place_id,
        name: d.name,
        description: d.description,
        banner_image_url: d.banner_image_url ?? null,
        images: d.images ?? [],
        phone: d.phone,
        address: d.address,
        status: d.status ?? "published",
        hospital_id: d.hospital_id ?? null,
        thumbnail_url: d.thumbnail_url ?? null,
        keywords: d.keywords ?? [],
        treatment_items: d.treatment_items ?? undefined,
        verified: d.verified ?? false,
        booking_url: d.booking_url ?? null,
        created_by: req.authSession!.user_id,
      },
    })
    .catch(() => null);
  if (row == null) {
    // Most likely the unique kakao_place_id already has a profile.
    res.status(409).json({ message: "profile already exists for this place" });
    return;
  }
  res.status(201).json(row);
});

// PATCH /hospital-profile/:id — edit.
router.patch("/:id", siteAdminRequired, async (req, res) => {
  const parsed = patchSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "invalid body" });
    return;
  }
  const row = await prisma.hospital_profile
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

// DELETE /hospital-profile/:id — remove.
router.delete("/:id", siteAdminRequired, async (req, res) => {
  await prisma.hospital_profile
    .delete({ where: { id: String(req.params.id) } })
    .catch(() => {});
  res.sendStatus(204);
});

export default router;
