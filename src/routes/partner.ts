import crypto from "crypto";
import fs from "fs";
import path from "path";
import express from "express";
import bcrypt from "bcrypt";
import multer from "multer";
import zod from "zod";
import { Prisma } from "@prisma/client";
import prisma from "../lib/prisma";
import {
  KakaoLookupError,
  hasKakaoKey,
  searchEyeClinics,
} from "../lib/kakaoPlaces";
import { validationBody, validationMessage } from "../lib/validationError";
import { partnerRequired, signPartnerToken } from "../lib/partnerAuth";
import { siteAdminRequired } from "../lib/middlewares";
import {
  assertTicket,
  issueCode,
  verifyCode,
  VerificationError,
} from "../services/emailVerification";

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

const MAX_UPLOAD_MB = 15;

/** multer 오류를 한국어 JSON으로. 기본 처리기는 HTML을 내보내서 클라이언트가
 *  메시지를 못 읽고 빈 알림창만 띄운다. */
function uploadErrorHandler(
  err: unknown,
  _req: express.Request,
  res: express.Response,
  next: express.NextFunction,
) {
  if (err instanceof multer.MulterError) {
    res.status(400).json({
      message:
        err.code === "LIMIT_FILE_SIZE"
          ? `사진 한 장은 ${MAX_UPLOAD_MB}MB까지 올릴 수 있습니다. 크기를 줄여 다시 시도해 주세요.`
          : "사진을 올리지 못했습니다.",
    });
    return;
  }
  next(err);
}

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (_req, file, cb) => {
      cb(null, `${crypto.randomUUID()}${path.extname(file.originalname).toLowerCase()}`);
    },
  }),
  // 병원이 올리는 건 대개 휴대폰 원본이라 5MB로는 자주 걸린다.
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 },
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

const pwEmailSchema = zod.object({ email: zod.string().email() });
const pwCodeSchema = zod.object({
  email: zod.string().email(),
  code: zod.string().regex(/^[0-9]{6}$/),
});
const pwResetSchema = zod.object({
  email: zod.string().email(),
  verificationTicket: zod.string().nonempty(),
  password: zod.string().min(8),
});

/* ------------------------------------------------------------------ *
 * 비밀번호 재설정
 *
 * 병원이 비밀번호를 잊으면 지금까지는 방법이 없었다. 운영자가 DB 에서
 * 해시를 바꿔주는 것 말고는 길이 없었는데, 실제 병원이 들어오기 시작하면
 * 그 요청을 매번 사람이 받게 된다.
 * ------------------------------------------------------------------ */

/** POST /partner/password/send-code */
router.post("/password/send-code", async (req, res) => {
  const parsed = pwEmailSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: validationMessage(parsed.error) });
    return;
  }
  const email = parsed.data.email.toLowerCase();
  const account = await prisma.hospital_account.findUnique({ where: { email } });
  if (account == null) {
    res.status(404).json({ message: "가입되지 않은 이메일입니다." });
    return;
  }
  try {
    await issueCode(email, "partner_reset");
    res.status(202).json({ ok: true });
  } catch (e) {
    if (e instanceof VerificationError) {
      res.status(429).json({ message: e.message });
      return;
    }
    throw e;
  }
});

/** POST /partner/password/verify-code */
router.post("/password/verify-code", async (req, res) => {
  const parsed = pwCodeSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: validationMessage(parsed.error) });
    return;
  }
  const { email, code } = parsed.data;
  try {
    const ticket = await verifyCode(email.toLowerCase(), code, "partner_reset");
    res.json({ verificationTicket: ticket });
  } catch (e) {
    if (e instanceof VerificationError) {
      res.status(400).json({ message: e.message });
      return;
    }
    throw e;
  }
});

/** POST /partner/password/reset */
router.post("/password/reset", async (req, res) => {
  const parsed = pwResetSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: validationMessage(parsed.error) });
    return;
  }
  const d = parsed.data;
  const email = d.email.toLowerCase();
  try {
    assertTicket(d.verificationTicket, email, "partner_reset");
  } catch (e) {
    if (e instanceof VerificationError) {
      res.status(400).json({ message: e.message });
      return;
    }
    throw e;
  }
  const account = await prisma.hospital_account.findUnique({ where: { email } });
  if (account == null) {
    res.status(404).json({ message: "가입되지 않은 이메일입니다." });
    return;
  }
  await prisma.hospital_account.update({
    where: { id: account.id },
    data: {
      password_hash: await bcrypt.hash(d.password, 10),
      // 이 시각보다 먼저 발급된 토큰은 거절된다(partnerRequired).
      password_changed_at: new Date(),
      updated_at: new Date(),
    },
  });
  res.json({ ok: true });
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
  treatment_categories: zod.array(zod.string()).optional(),
  treatment_items: zod.array(treatmentItemSchema).optional(),
  booking_url: zod.string().url().nullable().optional(),
  opening_hours: openingHoursSchema.nullable().optional(),
  doctors: zod.array(doctorSchema).max(MAX_DOCTORS).nullable().optional(),
  latitude: zod.number().min(-90).max(90).nullable().optional(),
  longitude: zod.number().min(-180).max(180).nullable().optional(),
});

// Upsert the partner's single profile. Published only once the account is
// approved; otherwise held as 'pending' (hidden from the app).
router.put("/profile", partnerRequired, async (req, res) => {
  const parsed = profileSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json(validationBody(parsed.error));
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
      treatment_categories: d.treatment_categories ?? undefined,
      treatment_items: d.treatment_items ?? undefined,
      opening_hours: d.opening_hours ?? undefined,
      doctors: d.doctors ?? undefined,
      // undefined면 컬럼을 건드리지 않는다(doctors/opening_hours와 같은 규칙).
      // null로 두면 좌표를 안 보내는 오래된 화면이 저장할 때마다 기존 좌표를
      // 지운다 - 백엔드만 먼저 배포된 동안 열려 있던 탭이 정확히 그 경우다.
      latitude: d.latitude ?? undefined,
      longitude: d.longitude ?? undefined,
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
    // kakao_place_id는 유니크다. 어드민이 온보딩용으로 먼저 만들어 둔 프로필이
    // 있으면 병원이 저장할 때 여기로 떨어진다 — 병원 잘못이 아니고, 관리자가
    // 소유권을 넘겨주면 해결된다. 그 사실을 알려주지 않으면 병원은 자기가
    // 뭘 잘못했는지 모른 채 막힌다.
    res.status(409).json({
      message:
        "이미 등록된 병원입니다. 관리자가 기존 프로필을 이 계정으로 넘겨드려야 수정할 수 있습니다.",
    });
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

/**
 * 고정 공지는 병원당 하나. 상세 화면 맨 위에 하나만 올라가는 자리라 여러 개를
 * 고정할 수 있으면 무엇이 보일지 병원이 예측할 수 없다.
 */
async function unpinOthers(profileId: string, keepNoticeId: string) {
  await prisma.hospital_notice.updateMany({
    where: { profile_id: profileId, pinned: true, id: { not: keepNoticeId } },
    data: { pinned: false },
  });
}

/* ---- 프로필 소유권 이관 ------------------------------------------------ *
 *
 * 온보딩은 어드민이 30여 곳을 미리 채우는 것으로 시작한다 — 병원 한 곳마다
 * 가입을 시키고 기다리면 시작 자체가 안 된다. 그런데 kakao_place_id가
 * 유니크라, 나중에 그 병원이 파트너로 가입하면 자기 프로필을 만들 수 없고
 * (409) 어드민이 만들어 둔 행에도 접근할 수 없다. 병원은 자기 공지 하나
 * 올리려고 계속 우리에게 연락해야 한다.
 *
 * 그래서 승인 시점에 소유권을 넘긴다. 주인이 없는 프로필만 넘길 수 있다 —
 * 이미 다른 계정이 쓰고 있는 프로필을 가져가는 것은 탈취다.
 * ----------------------------------------------------------------------- */
const handoverSchema = zod.object({ profile_id: zod.string().uuid() });

router.post("/accounts/:id/claim-profile", siteAdminRequired, async (req, res) => {
  const parsed = handoverSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: validationMessage(parsed.error) });
    return;
  }
  const accountId = String(req.params.id);
  const account = await prisma.hospital_account.findUnique({ where: { id: accountId } });
  if (account == null) {
    res.sendStatus(404);
    return;
  }
  // 한 계정이 프로필 여러 개를 갖는 구조가 아니다. 이미 있으면 무엇을
  // 넘기려는 것인지가 불분명하므로 거절한다.
  const existing = await prisma.hospital_profile.findFirst({
    where: { owner_account_id: accountId },
  });
  if (existing != null) {
    res.status(409).json({ message: "이 계정은 이미 프로필을 갖고 있습니다." });
    return;
  }
  const profile = await prisma.hospital_profile.findUnique({
    where: { id: parsed.data.profile_id },
  });
  if (profile == null) {
    res.status(404).json({ message: "프로필을 찾을 수 없습니다." });
    return;
  }
  if (profile.owner_account_id != null) {
    res.status(409).json({ message: "이미 다른 계정이 관리 중인 프로필입니다." });
    return;
  }
  const updated = await prisma.hospital_profile.update({
    where: { id: profile.id },
    data: {
      owner_account_id: accountId,
      // 승인된 계정에 넘기는 것이면 바로 노출된다. 아직 심사 중이면 프로필도
      // 같이 기다린다 - 승인 라우트가 같은 규칙을 쓴다.
      status: account.status === "approved" ? "published" : "pending",
      updated_at: new Date(),
    },
  });
  res.json({ id: updated.id, owner_account_id: updated.owner_account_id });
});

/** 주인이 없는 프로필 목록 — 승인 화면에서 넘길 대상을 고르는 데 쓴다. */
router.get("/unclaimed-profiles", siteAdminRequired, async (_req, res) => {
  const rows = await prisma.hospital_profile.findMany({
    where: { owner_account_id: null },
    orderBy: [{ name: "asc" }],
    select: { id: true, name: true, address: true, kakao_place_id: true },
  });
  res.json({ profiles: rows });
});

router.use(uploadErrorHandler);

/* ---- site-admin manages paid placement -------------------------------- *
 *                                                                         *
 * 등급은 관리자만 켠다. 파트너가 스스로 올릴 수 있으면 돈을 내지 않고도      *
 * 프리미엄이 된다 - verified 배지를 관리자 전용으로 둔 것과 같은 이유다.     *
 * ----------------------------------------------------------------------- */

const promotionSchema = zod.object({
  /** "eye" 면 심평원 요양기호, "optical" 이면 지자체 인허가번호. */
  kind: zod.enum(["eye", "optical"]),
  key: zod.string().trim().min(1).max(64),
  tier: zod.enum(["premium"]),
  /** YYYY-MM-DD. 끝나는 날은 그날 끝까지 유효하게 잡는다. */
  startsOn: zod.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endsOn: zod.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  accountId: zod.string().uuid().optional(),
  note: zod.string().trim().max(200).optional(),
});

/** GET /partner/facilities?q=... — 광고 걸 업체를 이름으로 찾는다.
 *
 *  번호를 손으로 옮겨 적게 했더니 25자짜리 인허가번호에서 앞 네 글자가
 *  빠진 채 저장되는 일이 났다. 등록은 성공한 것처럼 보이고 광고만 안
 *  나간다. 고르게 하면 그 실수가 아예 생기지 않는다. */
/** 이름·주소로 명부를 뒤진다. 운영자와 파트너가 같은 것을 고르므로 한
 *  군데서 만든다 - 따로 두면 한쪽에만 보이는 업체가 생긴다. */
async function facilitiesByName(q: string) {
  if (q.length < 2) return [];
  const like = { contains: q, mode: "insensitive" as const };
  const [clinics, shops] = await Promise.all([
    prisma.eye_clinic.findMany({
      where: { OR: [{ name: like }, { address: like }] },
      select: { ykiho: true, name: true, address: true },
      take: 15,
    }),
    prisma.optical_shop.findMany({
      where: { OR: [{ name: like }, { address: like }] },
      select: { license_no: true, name: true, address: true },
      take: 15,
    }),
  ]);
  return [
    ...clinics.map((c) => ({
      kind: "eye" as const,
      key: c.ykiho,
      name: c.name,
      address: c.address,
    })),
    ...shops.map((sh) => ({
      kind: "optical" as const,
      key: sh.license_no,
      name: sh.name,
      address: sh.address,
    })),
  ];
}

/** 운영자가 광고를 걸 업체를 찾는다. */
router.get("/facilities", siteAdminRequired, async (req, res) => {
  res.json(await facilitiesByName(String(req.query.q ?? "").trim()));
});

/** 파트너가 신청서에 자기 가게를 고른다.
 *
 *  명부 자체는 공개 자료지만 로그인은 걸어 둔다. 여기서 나오는 것은 곧
 *  광고를 걸 수 있는 대상 목록이라, 아무나 훑어 갈 이유가 없다. */
router.get("/my/facilities", partnerRequired, async (req, res) => {
  res.json(await facilitiesByName(String(req.query.q ?? "").trim()));
});

/* ---- 프리미엄 신청 ------------------------------------------------------
 *
 * 파트너가 신청하고 운영자가 허락하면 광고가 걸린다. 결제는 아직 없다 -
 * 승인이 곧 결제 확인 자리다. 나중에 결제창이 들어오면 "승인"이 "입금
 * 확인"으로 바뀌고 나머지 흐름은 그대로 쓴다.
 */

const promotionRequestSchema = zod.object({
  kind: zod.enum(["eye", "optical"]),
  key: zod.string().trim().min(1).max(64),
  facilityName: zod.string().trim().min(1).max(200),
  startsOn: zod.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  months: zod.number().int().min(1).max(12),
  note: zod.string().trim().max(500).optional(),
});

/** 하루의 시작과 끝을 KST 로 잡는다. 업체가 말하는 "9월 1일부터"는
 *  한국 시각 9월 1일 0시다. */
function kstDayStart(day: string): Date {
  return new Date(`${day}T00:00:00+09:00`);
}
function kstDayEnd(day: string): Date {
  return new Date(`${day}T23:59:59+09:00`);
}

/** DATE 칸에 넣을 값. 날짜만 담는 칸이라 시각이 붙으면 시간대에 따라
 *  하루가 밀린다 - KST 자정을 넣으면 UTC 서버에서는 전날로 저장된다.
 *  달력의 그 날을 그대로 담으려면 UTC 자정이어야 한다. */
function dateOnly(day: string): Date {
  return new Date(`${day}T00:00:00Z`);
}

/** 그 달의 마지막 날. */
function daysInMonth(year: number, month0: number): number {
  return new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();
}

/**
 * 시작일에 개월 수를 더한 마지막 날(KST).
 *
 * 달력 계산은 정수로 한다. Date 의 setMonth/getDate 는 서버의 지역 시각을
 * 따르는데, 서버가 한국 시각이라는 보장이 없어 하루씩 밀린다.
 *
 * 도착한 달에 그 날짜가 없으면 그 달의 말일까지다(민법 제160조). 1/31 에
 * 한 달을 더하면 2/31 은 없으니 2/28 까지이고, 거기서 하루를 더 빼면
 * 안 된다 - 2월에 신청한 업체만 하루를 손해 본다.
 */
function endOfTerm(startsOn: string, months: number): Date {
  const [y, m, d] = startsOn.split("-").map(Number);
  const targetMonth0 = m - 1 + months;
  const ty = y + Math.floor(targetMonth0 / 12);
  const tm0 = ((targetMonth0 % 12) + 12) % 12;
  const dim = daysInMonth(ty, tm0);
  // 같은 날짜가 있으면 그 전날까지가 한 달이다(9/1 시작 1개월 → 9/30).
  // 없으면 그 달의 말일까지다(1/31 시작 1개월 → 2/28).
  const end =
    d > dim
      ? new Date(Date.UTC(ty, tm0, dim))
      : new Date(Date.UTC(ty, tm0, d - 1));
  const yy = end.getUTCFullYear();
  const mm = String(end.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(end.getUTCDate()).padStart(2, "0");
  return kstDayEnd(`${yy}-${mm}-${dd}`);
}

function requestToDTO(r: {
  id: string;
  kind: string;
  key: string;
  facility_name: string;
  starts_on: Date;
  months: number;
  status: string;
  note: string | null;
  review_note: string | null;
  reviewed_at: Date | null;
  created_at: Date;
}) {
  return {
    id: r.id,
    kind: r.kind,
    key: r.key,
    facilityName: r.facility_name,
    startsOn: r.starts_on.toISOString().slice(0, 10),
    months: r.months,
    status: r.status,
    note: r.note,
    reviewNote: r.review_note,
    reviewedAt: r.reviewed_at?.toISOString() ?? null,
    createdAt: r.created_at.toISOString(),
  };
}

/** 파트너가 프리미엄을 신청한다. */
router.post("/promotion-requests", partnerRequired, async (req, res) => {
  const parsed = promotionRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "bad request", code: "bad_request" });
    return;
  }
  const b = parsed.data;

  // 고른 것이 실제로 명부에 있는 시설인지 본다. 화면에서 고르게 해 두었
  // 지만 창구는 화면 없이도 불릴 수 있고, 없는 번호로 신청이 들어오면
  // 운영자가 승인한 뒤에야 광고가 아무 데도 안 붙는 것을 알게 된다.
  const exists =
    b.kind === "eye"
      ? await prisma.eye_clinic.findUnique({ where: { ykiho: b.key }, select: { name: true } })
      : await prisma.optical_shop.findUnique({ where: { license_no: b.key }, select: { name: true } });
  if (exists == null) {
    res.status(404).json({ error: "facility not found", code: "facility_not_found" });
    return;
  }

  try {
    const row = await prisma.promotion_request.create({
      data: {
        account_id: req.partner!.sub,
        kind: b.kind,
        key: b.key,
        // 명부의 이름을 쓴다. 신청자가 적어 낸 이름은 오타가 섞인다.
        facility_name: exists.name,
        starts_on: dateOnly(b.startsOn),
        months: b.months,
        note: b.note ?? null,
      },
    });
    res.status(201).json(requestToDTO(row));
  } catch (e) {
    // 처리되지 않은 신청은 시설당 하나뿐이다(부분 유니크 인덱스). 같은
    // 곳을 두 번 신청하면 운영자가 같은 건을 두 번 승인하게 된다.
    if (
      e instanceof Prisma.PrismaClientKnownRequestError &&
      e.code === "P2002"
    ) {
      res.status(409).json({
        error: "already pending",
        code: "already_pending",
      });
      return;
    }
    throw e;
  }
});

/** 파트너가 자기 신청 내역을 본다. */
router.get("/promotion-requests/mine", partnerRequired, async (req, res) => {
  const rows = await prisma.promotion_request.findMany({
    where: { account_id: req.partner!.sub },
    orderBy: [{ created_at: "desc" }],
  });
  res.json(rows.map(requestToDTO));
});

/** 파트너가 아직 처리되지 않은 신청을 거둬들인다. */
router.delete("/promotion-requests/:id", partnerRequired, async (req, res) => {
  const row = await prisma.promotion_request.findUnique({
    where: { id: String(req.params.id) },
  });
  // 남의 신청인지 없는 신청인지 구분해 주지 않는다. 구분해 주면 남의
  // 신청 id 를 넣어 보는 것만으로 있는지 없는지 알 수 있다.
  if (row == null || row.account_id !== req.partner!.sub) {
    res.sendStatus(404);
    return;
  }
  if (row.status !== "pending") {
    res.status(409).json({ error: "already reviewed", code: "already_reviewed" });
    return;
  }
  await prisma.promotion_request.update({
    where: { id: row.id },
    data: { status: "cancelled", updated_at: new Date() },
  });
  res.sendStatus(204);
});

/** 운영자가 신청을 훑는다. 처리할 것이 먼저 온다. */
router.get("/promotion-requests", siteAdminRequired, async (req, res) => {
  const status = String(req.query.status ?? "");
  const rows = await prisma.promotion_request.findMany({
    where: status !== "" ? { status } : undefined,
    orderBy: [{ created_at: "desc" }],
    include: {
      account: { select: { id: true, hospital_name: true, email: true, contact_name: true } },
    },
  });
  res.json(
    rows.map((r) => ({
      ...requestToDTO(r),
      accountId: r.account.id,
      accountName: r.account.hospital_name,
      accountEmail: r.account.email,
      contactName: r.account.contact_name,
    })),
  );
});

/**
 * 운영자가 허락한다. 여기서 광고가 생긴다.
 *
 * 나중에 결제가 붙으면 이 자리가 "입금 확인"이 된다. 흐름은 그대로다.
 */
router.post("/promotion-requests/:id/approve", siteAdminRequired, async (req, res) => {
  const row = await prisma.promotion_request.findUnique({
    where: { id: String(req.params.id) },
  });
  if (row == null) {
    res.sendStatus(404);
    return;
  }
  if (row.status !== "pending") {
    res.status(409).json({ error: "already reviewed", code: "already_reviewed" });
    return;
  }

  const startsOn = row.starts_on.toISOString().slice(0, 10);
  const startsAt = kstDayStart(startsOn);
  const endsAt = endOfTerm(startsOn, row.months);

  // 이미 광고가 걸린 곳이면 기간을 이어 붙인다. 덮어쓰면 남은 기간이
  // 사라져 돈을 낸 만큼 나가지 않는다.
  //
  // 반대로 지난 광고가 남아 있는 곳이면 시작일도 함께 새로 잡는다. 끝나는
  // 날만 미루면 옛 시작일이 그대로 남아, 광고가 없던 사이 기간까지 살아
  // 있는 것으로 계산된다 - 돈을 안 받은 달에 광고가 나간다.
  const existing = await prisma.facility_promotion.findUnique({
    where: { kind_key: { kind: row.kind, key: row.key } },
  });
  const stillRunning = existing != null && existing.ends_at > startsAt;
  const term = endsAt.getTime() - startsAt.getTime();
  const nextStarts = stillRunning ? existing!.starts_at : startsAt;
  const nextEnds = stillRunning
    ? new Date(existing!.ends_at.getTime() + term)
    : endsAt;

  await prisma.$transaction([
    prisma.facility_promotion.upsert({
      where: { kind_key: { kind: row.kind, key: row.key } },
      create: {
        kind: row.kind,
        key: row.key,
        tier: "premium",
        starts_at: startsAt,
        ends_at: endsAt,
        account_id: row.account_id,
        note: row.note,
      },
      update: {
        starts_at: nextStarts,
        ends_at: nextEnds,
        // 계정을 다시 맞춰 둔다. 이 고리가 있어야 파트너가 자기 숫자를 본다.
        account_id: row.account_id,
        updated_at: new Date(),
      },
    }),
    prisma.promotion_request.update({
      where: { id: row.id },
      data: {
        status: "approved",
        reviewed_at: new Date(),
        review_note: typeof req.body?.note === "string" ? req.body.note : null,
        updated_at: new Date(),
      },
    }),
  ]);
  res.sendStatus(204);
});

/** 운영자가 거절한다. 사유는 파트너 화면에 그대로 보인다. */
router.post("/promotion-requests/:id/reject", siteAdminRequired, async (req, res) => {
  const note = String(req.body?.note ?? "").trim();
  if (note === "") {
    // 사유 없이 거절하면 업체는 무엇을 고쳐 다시 내야 할지 알 수 없다.
    res.status(400).json({ error: "note required", code: "note_required" });
    return;
  }
  const row = await prisma.promotion_request.findUnique({
    where: { id: String(req.params.id) },
  });
  if (row == null) {
    res.sendStatus(404);
    return;
  }
  if (row.status !== "pending") {
    res.status(409).json({ error: "already reviewed", code: "already_reviewed" });
    return;
  }
  await prisma.promotion_request.update({
    where: { id: row.id },
    data: {
      status: "rejected",
      review_note: note.slice(0, 500),
      reviewed_at: new Date(),
      updated_at: new Date(),
    },
  });
  res.sendStatus(204);
});

/** 날짜별 집계를 읽어 합계와 일자별 줄을 만든다. 파트너 화면과 어드민이
 *  같은 숫자를 봐야 해서 한 군데서 만든다 - 따로 세면 반드시 어긋난다. */
async function promotionStats(
  facilities: { kind: string; key: string }[],
  fromDay: Date,
) {
  if (facilities.length === 0) return new Map<string, { impressions: number; clicks: number; days: { day: string; impressions: number; clicks: number }[] }>();
  const rows = await prisma.promotion_stat_daily.findMany({
    where: { OR: facilities.map((f) => ({ kind: f.kind, key: f.key })), day: { gte: fromDay } },
    orderBy: { day: "asc" },
  });
  const out = new Map<string, { impressions: number; clicks: number; days: { day: string; impressions: number; clicks: number }[] }>();
  for (const r of rows) {
    const k = r.kind + ":" + r.key;
    const cur = out.get(k) ?? { impressions: 0, clicks: 0, days: [] };
    cur.impressions += r.impressions;
    cur.clicks += r.clicks;
    cur.days.push({
      day: r.day.toISOString().slice(0, 10),
      impressions: r.impressions,
      clicks: r.clicks,
    });
    out.set(k, cur);
  }
  return out;
}

/** 지난 N 일의 시작(KST). 기본 30 일. */
function statsFrom(days: number): Date {
  const kst = new Date(Date.now() + 9 * 3600 * 1000);
  const start = new Date(
    Date.UTC(kst.getUTCFullYear(), kst.getUTCMonth(), kst.getUTCDate()),
  );
  start.setUTCDate(start.getUTCDate() - (days - 1));
  return start;
}

/**
 * GET /partner/promotions/mine — 내 광고와 그 성적.
 *
 * 파트너가 자기 숫자를 직접 보게 한다. 지금까지는 어드민만 볼 수 있어,
 * 광고비를 받고도 "얼마나 보였냐"에 사람이 손으로 답해야 했다.
 *
 * 계정과 시설을 잇는 것은 facility_promotion.account_id 하나다. 어드민이
 * 광고를 등록할 때 계정을 고르지 않았다면 여기서는 아무것도 안 보인다.
 */
router.get("/promotions/mine", partnerRequired, async (req, res) => {
  const days = Math.min(Math.max(Number(req.query.days ?? 30) || 30, 1), 180);
  const mine = await prisma.facility_promotion.findMany({
    where: { account_id: req.partner!.sub },
    orderBy: [{ ends_at: "desc" }],
  });
  const stats = await promotionStats(mine, statsFrom(days));

  // 상호를 함께 낸다. 번호만 보여 주면 자기 가게인지도 알 수 없다.
  const [clinics, shops] = await Promise.all([
    prisma.eye_clinic.findMany({
      where: { ykiho: { in: mine.filter((p) => p.kind === "eye").map((p) => p.key) } },
      select: { ykiho: true, name: true, address: true },
    }),
    prisma.optical_shop.findMany({
      where: { license_no: { in: mine.filter((p) => p.kind === "optical").map((p) => p.key) } },
      select: { license_no: true, name: true, address: true },
    }),
  ]);
  const names = new Map<string, { name: string; address: string }>();
  for (const c of clinics) names.set("eye:" + c.ykiho, { name: c.name, address: c.address });
  for (const sh of shops) names.set("optical:" + sh.license_no, { name: sh.name, address: sh.address });

  const now = new Date();
  res.json(
    mine.map((p) => {
      const k = p.kind + ":" + p.key;
      const s = stats.get(k) ?? { impressions: 0, clicks: 0, days: [] };
      return {
        id: p.id,
        kind: p.kind,
        key: p.key,
        name: names.get(k)?.name ?? null,
        address: names.get(k)?.address ?? null,
        tier: p.tier,
        startsAt: p.starts_at.toISOString(),
        endsAt: p.ends_at.toISOString(),
        live: p.starts_at <= now && p.ends_at >= now,
        impressions: s.impressions,
        clicks: s.clicks,
        days: s.days,
      };
    }),
  );
});

router.get("/promotions", siteAdminRequired, async (_req, res) => {
  const rows = await prisma.facility_promotion.findMany({
    orderBy: [{ ends_at: "desc" }],
    include: { account: { select: { id: true, hospital_name: true, email: true } } },
  });

  // 번호만 보여 주면 어느 업체인지 알 수 없다. 명부에서 상호와 주소를
  // 끌어와 함께 보인다 - 번호가 틀려 아무 데도 안 붙는 광고를 등록한
  // 경우도 여기서 드러난다(이름이 비어 나온다).
  const eyeKeys = rows.filter((r) => r.kind === "eye").map((r) => r.key);
  const opticalKeys = rows.filter((r) => r.kind === "optical").map((r) => r.key);
  const [clinics, shops] = await Promise.all([
    eyeKeys.length > 0
      ? prisma.eye_clinic.findMany({
          where: { ykiho: { in: eyeKeys } },
          select: { ykiho: true, name: true, address: true },
        })
      : Promise.resolve([]),
    opticalKeys.length > 0
      ? prisma.optical_shop.findMany({
          where: { license_no: { in: opticalKeys } },
          select: { license_no: true, name: true, address: true },
        })
      : Promise.resolve([]),
  ]);
  const facility = new Map<string, { name: string; address: string }>([
    ...clinics.map(
      (c) => [`eye:${c.ykiho}`, { name: c.name, address: c.address }] as const,
    ),
    ...shops.map(
      (sh) =>
        [`optical:${sh.license_no}`, { name: sh.name, address: sh.address }] as const,
    ),
  ]);

  // 지난 30일 성적을 같이 낸다. 어드민이 파트너와 같은 숫자를 봐야
  // 문의가 왔을 때 화면을 맞춰 놓고 이야기할 수 있다.
  const stats = await promotionStats(rows, statsFrom(30));

  const now = Date.now();
  res.json(
    rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      key: r.key,
      impressions30d: stats.get(`${r.kind}:${r.key}`)?.impressions ?? 0,
      clicks30d: stats.get(`${r.kind}:${r.key}`)?.clicks ?? 0,
      facilityName: facility.get(`${r.kind}:${r.key}`)?.name ?? null,
      facilityAddress: facility.get(`${r.kind}:${r.key}`)?.address ?? null,
      tier: r.tier,
      startsOn: r.starts_at.toISOString().slice(0, 10),
      endsOn: r.ends_at.toISOString().slice(0, 10),
      // 기간이 지났는지는 화면이 다시 재지 않아도 되게 서버가 답한다.
      active: r.starts_at.getTime() <= now && r.ends_at.getTime() >= now,
      accountId: r.account?.id ?? null,
      accountName: r.account?.hospital_name ?? null,
      accountEmail: r.account?.email ?? null,
      note: r.note,
    })),
  );
});

router.put("/promotions", siteAdminRequired, async (req, res) => {
  const parsed = promotionSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid body", code: "validation_error" });
    return;
  }
  const b = parsed.data;
  // 끝나는 날 23:59:59 까지 살아 있게 한다. 날짜만 받아 그대로 쓰면 그날
  // 0시에 광고가 꺼져, 하루를 덜 받은 셈이 된다.
  const startsAt = new Date(`${b.startsOn}T00:00:00+09:00`);
  const endsAt = new Date(`${b.endsOn}T23:59:59+09:00`);
  if (endsAt.getTime() < startsAt.getTime()) {
    res.status(400).json({ error: "ends before starts", code: "validation_error" });
    return;
  }

  const row = await prisma.facility_promotion.upsert({
    where: { kind_key: { kind: b.kind, key: b.key } },
    create: {
      kind: b.kind,
      key: b.key,
      tier: b.tier,
      starts_at: startsAt,
      ends_at: endsAt,
      account_id: b.accountId ?? null,
      note: b.note ?? null,
    },
    update: {
      tier: b.tier,
      starts_at: startsAt,
      ends_at: endsAt,
      account_id: b.accountId ?? null,
      note: b.note ?? null,
      updated_at: new Date(),
    },
  });
  res.status(201).json({ id: row.id });
});

router.delete("/promotions/:id", siteAdminRequired, async (req, res) => {
  await prisma.facility_promotion
    .delete({ where: { id: String(req.params.id) } })
    .catch(() => null);
  res.sendStatus(200);
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
        // 카카오는 x=경도, y=위도를 문자열로 준다. 여기서 숫자로 바꿔
        // 두지 않으면 등록 폼이 문자열을 그대로 보내 zod에 걸린다.
        latitude: Number.parseFloat(d.y),
        longitude: Number.parseFloat(d.x),
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
    res.status(409).json({ message: "프로필을 먼저 저장한 뒤 소식을 등록할 수 있습니다." });
    return;
  }
  const row = await prisma.hospital_notice.create({
    data: { ...parsed.data, profile_id: profile.id },
  });
  if (row.pinned) await unpinOthers(profile.id, row.id);
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
  if (parsed.data.pinned) {
    await unpinOthers(profile.id, String(req.params.id));
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
