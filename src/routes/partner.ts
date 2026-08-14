import crypto from "crypto";
import fs from "fs";
import path from "path";
import express from "express";
import bcrypt from "bcrypt";
import multer from "multer";
import zod from "zod";
import prisma from "../lib/prisma";
import {
  KakaoLookupError,
  hasKakaoKey,
  searchEyeClinics,
} from "../lib/kakaoPlaces";
import { validationMessage } from "../lib/validationError";
import { partnerRequired, signPartnerToken } from "../lib/partnerAuth";
import { siteAdminRequired } from "../lib/middlewares";

const router = express.Router();

/** Generous for a clinic page, but bounded — an unbounded array lets one
 *  request store a document of any size. */
const MAX_DETAIL_BLOCKS = 100;

/** Ten is a carousel; beyond that nobody swipes and the page just gets heavy. */
const MAX_BANNERS = 10;

// Shared with hospital_profile.ts's uploads (served publicly there at
// /api/hospital-profile/uploads/:filename), so we don't duplicate the serve
// route — partner uploads just land in the same directory.
const UPLOAD_DIR = path.join(__dirname, "../../uploads/hospital-profiles");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const PUBLIC_ORIGIN = "https://myopiamanage.org";

// Whitelist raster extensions only. mimetype is client-spoofable, and these
// files are served back by extension (res.sendFile) — allowing e.g. .svg/.html
// would let a spoofed upload be served as renderable content (stored XSS).
const ALLOWED_EXT = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif"]);

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (_req, file, cb) => {
      cb(null, `${crypto.randomUUID()}${path.extname(file.originalname).toLowerCase()}`);
    },
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, /^image\//.test(file.mimetype) && ALLOWED_EXT.has(ext));
  },
});

/* ---- partner-facing auth ---------------------------------------------- */

const signupSchema = zod.object({
  email: zod.string().email(),
  password: zod.string().min(8),
  contact_name: zod.string().min(1),
  hospital_name: zod.string().min(1),
});

router.post("/signup", async (req, res) => {
  const parsed = signupSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: validationMessage(parsed.error) });
    return;
  }
  const d = parsed.data;
  const hash = await bcrypt.hash(d.password, 10);
  const account = await prisma.hospital_account
    .create({
      data: {
        email: d.email.toLowerCase(),
        password_hash: hash,
        contact_name: d.contact_name,
        hospital_name: d.hospital_name,
      },
    })
    .catch(() => null);
  if (account == null) {
    res.status(409).json({ message: "email already registered" });
    return;
  }
  res.status(201).json({ id: account.id, status: account.status });
});

router.post("/login", async (req, res) => {
  const email = typeof req.body?.email === "string" ? req.body.email.toLowerCase() : "";
  const password = typeof req.body?.password === "string" ? req.body.password : "";
  const account = await prisma.hospital_account.findUnique({ where: { email } });
  if (account == null || !(await bcrypt.compare(password, account.password_hash))) {
    res.status(401).json({ message: "wrong email or password" });
    return;
  }
  const { token, expiresIn } = signPartnerToken(account.id);
  res.json({ token, expiresIn, status: account.status });
});

router.get("/me", partnerRequired, async (req, res) => {
  const account = await prisma.hospital_account.findUnique({
    where: { id: req.partner!.sub },
  });
  if (account == null) {
    res.sendStatus(404);
    return;
  }
  res.json({
    id: account.id,
    email: account.email,
    contactName: account.contact_name,
    hospitalName: account.hospital_name,
    status: account.status,
  });
});

/* ---- partner manages their own profile -------------------------------- */

router.post("/profile/upload", partnerRequired, upload.single("image"), (req, res) => {
  if (!req.file) {
    res.status(400).json({ message: "no image file (or not an image)" });
    return;
  }
  res.status(201).json({
    url: `${PUBLIC_ORIGIN}/api/hospital-profile/uploads/${req.file.filename}`,
  });
});

/** POST /partner/profile/upload-many — several images in one go.
 *  Picking banner photos one file at a time is the slowest part of setting up
 *  a profile, and a clinic uploads them in batches. */
router.post(
  "/profile/upload-many",
  partnerRequired,
  upload.array("images", MAX_BANNERS),
  (req, res) => {
    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    if (files.length === 0) {
      res.status(400).json({ message: "no image files (or not images)" });
      return;
    }
    res.status(201).json({
      urls: files.map(
        (f) => `${PUBLIC_ORIGIN}/api/hospital-profile/uploads/${f.filename}`,
      ),
    });
  },
);

router.get("/profile", partnerRequired, async (req, res) => {
  const profile = await prisma.hospital_profile.findFirst({
    where: { owner_account_id: req.partner!.sub },
  });
  res.json(profile);
});

const treatmentItemSchema = zod.object({
  category: zod.string().min(1),
  name: zod.string().min(1),
  normalPrice: zod.number().nullable().optional(),
  eventPrice: zod.number().nullable().optional(),
  description: zod.string().optional(),
});

// Partners set their own marketing fields, but NOT hospital_id or verified —
// those gate review eligibility and the trust badge, so they stay admin-only.
/** A day is either closed (null) or a range, optionally with a lunch break. */
const dayHoursSchema = zod
  .object({
    open: zod.string().regex(/^\d{2}:\d{2}$/),
    close: zod.string().regex(/^\d{2}:\d{2}$/),
    lunchStart: zod.string().regex(/^\d{2}:\d{2}$/).nullable().optional(),
    lunchEnd: zod.string().regex(/^\d{2}:\d{2}$/).nullable().optional(),
  })
  .nullable();

const openingHoursSchema = zod.object({
  mon: dayHoursSchema.optional(),
  tue: dayHoursSchema.optional(),
  wed: dayHoursSchema.optional(),
  thu: dayHoursSchema.optional(),
  fri: dayHoursSchema.optional(),
  sat: dayHoursSchema.optional(),
  sun: dayHoursSchema.optional(),
  /** Free text for the things a grid can't express (공휴일 휴진 등). */
  note: zod.string().max(200).optional(),
});

/** 의사 한 명. 이름만 필수 — 사진과 소개는 나중에 채워도 섹션이 성립한다. */
const doctorSchema = zod.object({
  name: zod.string().min(1).max(40),
  title: zod.string().max(60).nullable().optional(),
  photoUrl: zod.string().url().nullable().optional(),
  bio: zod.string().max(2000).nullable().optional(),
});
const MAX_DOCTORS = 20;

/** A blog-style body block: a paragraph or a picture, in order. */
const detailBlockSchema = zod.discriminatedUnion("type", [
  zod.object({ type: zod.literal("text"), text: zod.string().max(5000) }),
  zod.object({ type: zod.literal("image"), url: zod.string().url() }),
]);

const profileSchema = zod.object({
  kakao_place_id: zod.string().min(1),
  name: zod.string().min(1),
  description: zod.string().optional(),
  banner_image_url: zod.string().url().nullable().optional(),
  images: zod.array(zod.string().url()).max(MAX_BANNERS).optional(),
  tagline: zod.string().max(120).nullable().optional(),
  detail_blocks: zod.array(detailBlockSchema).max(MAX_DETAIL_BLOCKS).nullable().optional(),
  phone: zod.string().optional(),
  address: zod.string().optional(),
  thumbnail_url: zod.string().url().nullable().optional(),
  keywords: zod.array(zod.string()).optional(),
  treatment_items: zod.array(treatmentItemSchema).optional(),
  booking_url: zod.string().url().nullable().optional(),
  opening_hours: openingHoursSchema.nullable().optional(),
  doctors: zod.array(doctorSchema).max(MAX_DOCTORS).nullable().optional(),
});

// Upsert the partner's single profile. Published only once the account is
// approved; otherwise held as 'pending' (hidden from the app).
router.put("/profile", partnerRequired, async (req, res) => {
  const parsed = profileSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: validationMessage(parsed.error) });
    return;
  }
  const account = await prisma.hospital_account.findUnique({
    where: { id: req.partner!.sub },
  });
  if (account == null) {
    res.sendStatus(404);
    return;
  }
  const status = account.status === "approved" ? "published" : "pending";
  const d = parsed.data;
  const existing = await prisma.hospital_profile.findFirst({
    where: { owner_account_id: account.id },
  });
  try {
    const data = {
      kakao_place_id: d.kakao_place_id,
      name: d.name,
      description: d.description,
      banner_image_url: d.banner_image_url ?? null,
      images: d.images ?? [],
      phone: d.phone,
      address: d.address,
      thumbnail_url: d.thumbnail_url ?? null,
      keywords: d.keywords ?? [],
      treatment_items: d.treatment_items ?? undefined,
      opening_hours: d.opening_hours ?? undefined,
      doctors: d.doctors ?? undefined,
      tagline: d.tagline ?? null,
      detail_blocks: d.detail_blocks ?? undefined,
      booking_url: d.booking_url ?? null,
      status,
      owner_account_id: account.id,
      updated_at: new Date(),
    };
    const row = existing
      ? await prisma.hospital_profile.update({ where: { id: existing.id }, data })
      : await prisma.hospital_profile.create({ data });
    res.json(row);
  } catch {
    // kakao_place_id already claimed by someone else's profile.
    res.status(409).json({ message: "this place is already registered" });
  }
});

/* ---- site-admin approves partner accounts ----------------------------- */

router.get("/accounts", siteAdminRequired, async (_req, res) => {
  const rows = await prisma.hospital_account.findMany({
    orderBy: [{ created_at: "desc" }],
  });
  // Attach the profile each account claimed so the admin can verify the
  // claimed hospital (kakao place) actually matches the applicant before
  // approving — a partner can put any place_id on their profile, so this
  // manual check is the real guard against impersonation.
  const profiles = await prisma.hospital_profile.findMany({
    where: { owner_account_id: { in: rows.map((a) => a.id) } },
  });
  const byOwner = new Map(profiles.map((p) => [p.owner_account_id, p]));
  res.json(
    rows.map((a) => {
      const p = byOwner.get(a.id);
      return {
        id: a.id,
        email: a.email,
        contactName: a.contact_name,
        hospitalName: a.hospital_name,
        status: a.status,
        createdAt: a.created_at.toISOString(),
        claimedPlaceId: p?.kakao_place_id ?? null,
        claimedName: p?.name ?? null,
      };
    }),
  );
});

const statusSchema = zod.object({ status: zod.enum(["approved", "rejected", "pending"]) });

router.patch("/accounts/:id", siteAdminRequired, async (req, res) => {
  const parsed = statusSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: validationMessage(parsed.error) });
    return;
  }
  const id = String(req.params.id);
  const account = await prisma.hospital_account
    .update({ where: { id }, data: { status: parsed.data.status, updated_at: new Date() } })
    .catch(() => null);
  if (account == null) {
    res.sendStatus(404);
    return;
  }
  // Approving/rejecting flips the visibility of their profile too.
  const profileStatus = parsed.data.status === "approved" ? "published" : "pending";
  await prisma.hospital_profile.updateMany({
    where: { owner_account_id: id },
    data: { status: profileStatus, updated_at: new Date() },
  });
  res.json({ id: account.id, status: account.status });
});

export default router;

/* ---- 소식 (clinic notices) --------------------------------------------- *
 * A clinic posts these itself: reopening dates, doctor changes, events. They
 * hang off the clinic's own profile, so every handler resolves the profile
 * from the logged-in partner rather than trusting an id from the request.
 * ----------------------------------------------------------------------- */

const noticeSchema = zod.object({
  title: zod.string().trim().min(1).max(120),
  body: zod.string().trim().min(1).max(5000),
  kind: zod.enum(["notice", "event"]).optional(),
  pinned: zod.boolean().optional(),
  published: zod.boolean().optional(),
});

/** The partner's own profile, or null when they haven't created one yet. */
async function ownProfile(partnerId: string) {
  return prisma.hospital_profile.findFirst({
    where: { owner_account_id: partnerId },
    select: { id: true },
  });
}

/** GET /partner/notices */
/* ---- 카카오 병원 검색 (프로필 등록 보조) ------------------------------- *
 * 프로필은 카카오 place id 로 묶인다. 병원 담당자에게 그 번호를 찾아
 * 입력하라고 하면 오타가 나고, 오타여도 저장은 성공해서 앱에 아무것도
 * 안 뜨는데 원인을 알 방법이 없다. 이름으로 찾아 고르게 하면 그 부류의
 * 문제가 통째로 사라지고 전화·주소도 함께 채워진다.
 * ----------------------------------------------------------------------- */
router.get("/place-search", partnerRequired, async (req, res) => {
  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
  if (q.length < 2) {
    res.json({ places: [] });
    return;
  }
  if (!hasKakaoKey()) {
    res.status(503).json({ message: "카카오 검색 키가 설정되지 않았습니다." });
    return;
  }
  try {
    const docs = await searchEyeClinics(q);
    res.json({
      places: docs.map((d) => ({
        id: d.id,
        name: d.place_name,
        category: d.category_name,
        phone: d.phone || null,
        address: d.address_name || null,
        roadAddress: d.road_address_name || null,
      })),
    });
  } catch (err) {
    const status = err instanceof KakaoLookupError ? err.status : 0;
    res.status(502).json({
      message:
        status === 403
          ? "카카오 검색이 거부되었습니다 (앱 설정 확인 필요)."
          : "카카오 검색에 실패했습니다.",
    });
  }
});

router.get("/notices", partnerRequired, async (req, res) => {
  const profile = await ownProfile(req.partner!.sub);
  if (profile == null) {
    res.json({ notices: [] });
    return;
  }
  const rows = await prisma.hospital_notice.findMany({
    where: { profile_id: profile.id },
    orderBy: [{ pinned: "desc" }, { created_at: "desc" }],
  });
  res.json({
    notices: rows.map((n) => ({
      id: n.id,
      title: n.title,
      body: n.body,
      kind: n.kind,
      pinned: n.pinned,
      published: n.published,
      createdAt: n.created_at.toISOString(),
    })),
  });
});

/** POST /partner/notices */
router.post("/notices", partnerRequired, async (req, res) => {
  const parsed = noticeSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: validationMessage(parsed.error) });
    return;
  }
  const profile = await ownProfile(req.partner!.sub);
  if (profile == null) {
    res.status(409).json({ message: "create the hospital profile first" });
    return;
  }
  const row = await prisma.hospital_notice.create({
    data: { ...parsed.data, profile_id: profile.id },
  });
  res.status(201).json({ id: row.id });
});

/** PATCH /partner/notices/:id */
router.patch("/notices/:id", partnerRequired, async (req, res) => {
  const parsed = noticeSchema.partial().safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: validationMessage(parsed.error) });
    return;
  }
  const profile = await ownProfile(req.partner!.sub);
  if (profile == null) {
    res.sendStatus(404);
    return;
  }
  // Scoped by profile_id as well as id — otherwise a partner could edit
  // another clinic's notice by guessing its id.
  const result = await prisma.hospital_notice.updateMany({
    where: { id: String(req.params.id), profile_id: profile.id },
    data: { ...parsed.data, updated_at: new Date() },
  });
  if (result.count === 0) {
    res.sendStatus(404);
    return;
  }
  res.json({ ok: true });
});

/** DELETE /partner/notices/:id */
router.delete("/notices/:id", partnerRequired, async (req, res) => {
  const profile = await ownProfile(req.partner!.sub);
  if (profile == null) {
    res.sendStatus(404);
    return;
  }
  const result = await prisma.hospital_notice.deleteMany({
    where: { id: String(req.params.id), profile_id: profile.id },
  });
  res.sendStatus(result.count === 0 ? 404 : 204);
});
