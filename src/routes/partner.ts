import crypto from "crypto";
import fs from "fs";
import path from "path";
import express from "express";
import bcrypt from "bcrypt";
import multer from "multer";
import zod from "zod";
import prisma from "../lib/prisma";
import { partnerRequired, signPartnerToken } from "../lib/partnerAuth";
import { siteAdminRequired } from "../lib/middlewares";

const router = express.Router();

// Shared with hospital_profile.ts's uploads (served publicly there at
// /api/hospital-profile/uploads/:filename), so we don't duplicate the serve
// route — partner uploads just land in the same directory.
const UPLOAD_DIR = path.join(__dirname, "../../uploads/hospital-profiles");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const PUBLIC_ORIGIN = "https://myopiamanage.org";

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (_req, file, cb) => {
      cb(null, `${crypto.randomUUID()}${path.extname(file.originalname).toLowerCase()}`);
    },
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => cb(null, /^image\//.test(file.mimetype)),
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
    res.status(400).json({ message: "invalid body" });
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

router.get("/profile", partnerRequired, async (req, res) => {
  const profile = await prisma.hospital_profile.findFirst({
    where: { owner_account_id: req.partner!.sub },
  });
  res.json(profile);
});

const profileSchema = zod.object({
  kakao_place_id: zod.string().min(1),
  name: zod.string().min(1),
  description: zod.string().optional(),
  banner_image_url: zod.string().url().nullable().optional(),
  images: zod.array(zod.string().url()).optional(),
  phone: zod.string().optional(),
  address: zod.string().optional(),
});

// Upsert the partner's single profile. Published only once the account is
// approved; otherwise held as 'pending' (hidden from the app).
router.put("/profile", partnerRequired, async (req, res) => {
  const parsed = profileSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "invalid body" });
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
  res.json(
    rows.map((a) => ({
      id: a.id,
      email: a.email,
      contactName: a.contact_name,
      hospitalName: a.hospital_name,
      status: a.status,
      createdAt: a.created_at.toISOString(),
    })),
  );
});

const statusSchema = zod.object({ status: zod.enum(["approved", "rejected", "pending"]) });

router.patch("/accounts/:id", siteAdminRequired, async (req, res) => {
  const parsed = statusSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "invalid body" });
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
