import crypto from "crypto";
import fs from "fs";
import path from "path";
import express from "express";
import multer from "multer";
import zod from "zod";
import { Prisma } from "@prisma/client";
import prisma from "../lib/prisma";
import {
  KakaoLookupError,
  hasKakaoKey,
  searchEyeClinics,
} from "../lib/kakaoPlaces";
import { validationMessage } from "../lib/validationError";
import { hospitalAdminRequired, siteAdminRequired } from "../lib/middlewares";

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

/** Generous for a clinic page, but bounded — an unbounded array lets one
 *  request store a document of any size. */
const MAX_DETAIL_BLOCKS = 100;

/** Ten is a carousel; beyond that nobody swipes and the page just gets heavy. */
const MAX_BANNERS = 10;

const createSchema = zod.object({
  kakao_place_id: zod.string().min(1),
  name: zod.string().min(1),
  description: zod.string().optional(),
  banner_image_url: zod.string().url().nullable().optional(),
  images: zod.array(zod.string().url()).max(MAX_BANNERS).optional(),
  tagline: zod.string().max(120).nullable().optional(),
  detail_blocks: zod.array(detailBlockSchema).max(MAX_DETAIL_BLOCKS).nullable().optional(),
  phone: zod.string().optional(),
  address: zod.string().optional(),
  status: zod.enum(STATUSES).optional(),
  hospital_id: zod.string().uuid().nullable().optional(),
  thumbnail_url: zod.string().url().nullable().optional(),
  keywords: zod.array(zod.string()).optional(),
  treatment_items: zod.array(treatmentItemSchema).optional(),
  verified: zod.boolean().optional(),
  booking_url: zod.string().url().nullable().optional(),
  opening_hours: openingHoursSchema.nullable().optional(),
  doctors: zod.array(doctorSchema).max(MAX_DOCTORS).nullable().optional(),
  latitude: zod.number().min(-90).max(90).nullable().optional(),
  longitude: zod.number().min(-180).max(180).nullable().optional(),
});
const patchSchema = createSchema.partial();

// POST /hospital-profile/upload — admin image upload, returns { url }.
// POST /hospital-profile/upload-many — several images in one request.
router.post(
  "/upload-many",
  siteAdminRequired,
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
    res.status(400).json({ message: validationMessage(parsed.error) });
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
/* ---- 카카오 병원 검색 (프로필 등록 보조) ------------------------------- *
 * 프로필은 카카오 place id 로 묶인다. 병원 담당자에게 그 번호를 찾아
 * 입력하라고 하면 오타가 나고, 오타여도 저장은 성공해서 앱에 아무것도
 * 안 뜨는데 원인을 알 방법이 없다. 이름으로 찾아 고르게 하면 그 부류의
 * 문제가 통째로 사라지고 전화·주소도 함께 채워진다.
 * ----------------------------------------------------------------------- */
router.get("/place-search", siteAdminRequired, async (req, res) => {
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

/* ---- 병원 관리자 본인 프로필 ------------------------------------------ *
 *
 * myopia를 이미 쓰는 병원은 원장·관리자 계정이 이미 있다. 그 병원이 myodoc
 * 프로필을 관리하려고 파트너 계정을 또 만들고 다른 주소로 또 로그인해야 한다면,
 * 같은 회사 서비스인데 계정이 둘이라는 설명을 병원마다 해야 한다.
 *
 * 그래서 병원 관리자(healthcare_professional.is_admin)가 자기 병원에 연결된
 * 프로필을 직접 관리하게 한다. 범위는 hospital_id로 고정된다 — 로그인한
 * 사람의 병원 말고는 손댈 수 없고, 프로필이 어느 병원에 붙는지도 본인이
 * 고르지 못한다.
 *
 * 파트너 계정과 달리 승인 절차가 없는 이유: 이 계정은 이미 진료 데이터를
 * 다루도록 승인된 계정이다. 신원은 그때 확인됐다.
 *
 * `/:id`보다 먼저 등록해야 한다 — 아니면 "mine"이 프로필 id로 해석된다.
 * ----------------------------------------------------------------------- */

/** 병원 관리자가 못 만지는 것: 어느 병원에 붙는지, 인증 뱃지, 노출 상태.
 *  앞의 둘은 신뢰 표시라 우리가 정하고, 상태는 아래에서 정해진다. */
const hospitalOwnProfileSchema = createSchema.omit({
  hospital_id: true,
  verified: true,
  status: true,
});

router.get("/mine", hospitalAdminRequired, async (req, res) => {
  const profile = await prisma.hospital_profile.findFirst({
    where: { hospital_id: req.healthcare_professional!.hospital_id },
  });
  res.json(profile);
});

router.put("/mine", hospitalAdminRequired, async (req, res) => {
  const parsed = hospitalOwnProfileSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: validationMessage(parsed.error) });
    return;
  }
  const hospitalId = req.healthcare_professional!.hospital_id;
  const d = parsed.data;
  const existing = await prisma.hospital_profile.findFirst({
    where: { hospital_id: hospitalId },
  });

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
    latitude: d.latitude ?? undefined,
    longitude: d.longitude ?? undefined,
    tagline: d.tagline ?? null,
    detail_blocks: d.detail_blocks ?? undefined,
    booking_url: d.booking_url ?? null,
    // 이미 진료 데이터를 다루는 병원이라 노출을 미룰 이유가 없다.
    status: "published",
    hospital_id: hospitalId,
    updated_at: new Date(),
  };

  try {
    const row = existing
      ? await prisma.hospital_profile.update({ where: { id: existing.id }, data })
      : await prisma.hospital_profile.create({ data });
    res.json(row);
  } catch {
    // 이 카카오 장소를 다른 병원이 이미 쓰고 있다. 장소를 잘못 고른 경우가
    // 대부분이라, 그 사실을 알려줘야 다시 고를 수 있다.
    res.status(409).json({
      message: "이미 다른 계정이 등록한 병원입니다. 검색에서 올바른 지점을 선택했는지 확인해 주세요.",
    });
  }
});

/* ---- 병원 관리자의 소식 ------------------------------------------------ *
 * 프로필을 병원이 직접 관리하는데 공지만 우리에게 부탁해야 한다면 반쪽이다.
 * 휴진 안내처럼 시급한 것이 대부분이라 특히 그렇다.
 * 자기 병원 프로필에 달린 소식만 보이고 만질 수 있다.
 * ----------------------------------------------------------------------- */

/** 로그인한 관리자의 병원 프로필. 없으면 null — 소식은 프로필에 달린다. */
async function ownHospitalProfile(hospitalId: string) {
  return prisma.hospital_profile.findFirst({ where: { hospital_id: hospitalId } });
}

router.get("/mine/notices", hospitalAdminRequired, async (req, res) => {
  const profile = await ownHospitalProfile(req.healthcare_professional!.hospital_id);
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

router.post("/mine/notices", hospitalAdminRequired, async (req, res) => {
  const parsed = adminNoticeSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: validationMessage(parsed.error) });
    return;
  }
  const profile = await ownHospitalProfile(req.healthcare_professional!.hospital_id);
  if (profile == null) {
    res.status(409).json({ message: "프로필을 먼저 저장한 뒤 소식을 등록할 수 있습니다." });
    return;
  }
  const row = await prisma.hospital_notice.create({
    data: { ...parsed.data, profile_id: profile.id },
  });
  res.status(201).json({ id: row.id });
});

/** 소식 수정·삭제. 내 병원 프로필에 달린 것만 — id만 보고 고치면 남의 병원
 *  공지를 건드릴 수 있다. */
async function ownNotice(hospitalId: string, noticeId: string) {
  const profile = await ownHospitalProfile(hospitalId);
  if (profile == null) return null;
  return prisma.hospital_notice.findFirst({
    where: { id: noticeId, profile_id: profile.id },
  });
}

router.patch("/mine/notices/:noticeId", hospitalAdminRequired, async (req, res) => {
  const parsed = adminNoticeSchema.partial().safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: validationMessage(parsed.error) });
    return;
  }
  const notice = await ownNotice(
    req.healthcare_professional!.hospital_id,
    String(req.params.noticeId),
  );
  if (notice == null) {
    res.sendStatus(404);
    return;
  }
  await prisma.hospital_notice.update({
    where: { id: notice.id },
    data: { ...parsed.data, updated_at: new Date() },
  });
  res.json({ ok: true });
});

router.delete("/mine/notices/:noticeId", hospitalAdminRequired, async (req, res) => {
  const notice = await ownNotice(
    req.healthcare_professional!.hospital_id,
    String(req.params.noticeId),
  );
  if (notice == null) {
    res.sendStatus(404);
    return;
  }
  await prisma.hospital_notice.delete({ where: { id: notice.id } });
  res.sendStatus(204);
});

/** 장소 검색 — 어드민용과 같지만 병원 관리자도 쓸 수 있어야 한다. */
router.get("/mine/place-search", hospitalAdminRequired, async (req, res) => {
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

/** 이미지 업로드 — 배너·의사 사진용. */
router.post(
  "/mine/upload-many",
  hospitalAdminRequired,
  upload.array("images", MAX_BANNERS),
  (req, res) => {
    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    if (files.length === 0) {
      res.status(400).json({ message: "no image files (or not images)" });
      return;
    }
    res.json({
      urls: files.map(
        (f) => `${PUBLIC_ORIGIN}/api/hospital-profile/uploads/${f.filename}`,
      ),
    });
  },
);

router.post(
  "/mine/upload",
  hospitalAdminRequired,
  upload.single("image"),
  (req, res) => {
    if (req.file == null) {
      res.status(400).json({ message: "no image file (or not an image)" });
      return;
    }
    res.json({
      url: `${PUBLIC_ORIGIN}/api/hospital-profile/uploads/${req.file.filename}`,
    });
  },
);

router.get("/", siteAdminRequired, async (_req, res) => {
  const rows = await prisma.hospital_profile.findMany({
    orderBy: [{ updated_at: "desc" }],
  });
  res.json(rows);
});

/* These must sit above the `/:id` handlers: registered after them,
 * `/:id` matches "notices" and swallows every notice request. */
// PATCH /hospital-profile/notices/:noticeId
router.patch("/notices/:noticeId", siteAdminRequired, async (req, res) => {
  const parsed = adminNoticeSchema.partial().safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: validationMessage(parsed.error) });
    return;
  }
  const row = await prisma.hospital_notice
    .update({
      where: { id: String(req.params.noticeId) },
      data: { ...parsed.data, updated_at: new Date() },
    })
    .catch(() => null);
  if (row == null) {
    res.sendStatus(404);
    return;
  }
  res.json({ ok: true });
});

// DELETE /hospital-profile/notices/:noticeId
router.delete("/notices/:noticeId", siteAdminRequired, async (req, res) => {
  const ok = await prisma.hospital_notice
    .delete({ where: { id: String(req.params.noticeId) } })
    .then(() => true)
    .catch(() => false);
  res.sendStatus(ok ? 204 : 404);
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
    res.status(400).json({ message: validationMessage(parsed.error) });
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
        opening_hours: d.opening_hours ?? undefined,
        doctors: d.doctors ?? undefined,
        // undefined면 컬럼을 건드리지 않는다(doctors/opening_hours와 같은 규칙).
        // null로 두면 좌표를 안 보내는 오래된 화면이 저장할 때마다 기존 좌표를
        // 지운다 - 백엔드만 먼저 배포된 동안 열려 있던 탭이 정확히 그 경우다.
        latitude: d.latitude ?? undefined,
        longitude: d.longitude ?? undefined,
        tagline: d.tagline ?? null,
        detail_blocks: d.detail_blocks ?? undefined,
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
    res.status(400).json({ message: validationMessage(parsed.error) });
    return;
  }
  const { opening_hours, detail_blocks, doctors, ...rest } = parsed.data;
  const row = await prisma.hospital_profile
    .update({
      where: { id: String(req.params.id) },
      data: {
        ...rest,
        // Prisma wants JSON handed over on its own: `undefined` leaves the
        // column alone, an explicit null clears it.
        ...(opening_hours !== undefined && {
          opening_hours: opening_hours ?? Prisma.DbNull,
        }),
        ...(detail_blocks !== undefined && {
          detail_blocks: detail_blocks ?? Prisma.DbNull,
        }),
        ...(doctors !== undefined && {
          doctors: doctors ?? Prisma.DbNull,
        }),
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

// DELETE /hospital-profile/:id — remove.
router.delete("/:id", siteAdminRequired, async (req, res) => {
  await prisma.hospital_profile
    .delete({ where: { id: String(req.params.id) } })
    .catch(() => {});
  res.sendStatus(204);
});

export default router;

/* ---- 소식 (admin side) --------------------------------------------------
 * Admins manage notices on behalf of clinics during onboarding — most clinics
 * won't log in to write their own on day one. Same table as the partner API.
 * ----------------------------------------------------------------------- */

const adminNoticeSchema = zod.object({
  title: zod.string().trim().min(1).max(120),
  body: zod.string().trim().min(1).max(5000),
  kind: zod.enum(["notice", "event"]).optional(),
  pinned: zod.boolean().optional(),
  published: zod.boolean().optional(),
});

// GET /hospital-profile/:id/notices
router.get("/:id/notices", siteAdminRequired, async (req, res) => {
  const rows = await prisma.hospital_notice.findMany({
    where: { profile_id: String(req.params.id) },
    orderBy: [{ pinned: "desc" }, { created_at: "desc" }],
  });
  res.json(
    rows.map((n) => ({
      id: n.id,
      title: n.title,
      body: n.body,
      kind: n.kind,
      pinned: n.pinned,
      published: n.published,
      createdAt: n.created_at.toISOString(),
    })),
  );
});

// POST /hospital-profile/:id/notices
router.post("/:id/notices", siteAdminRequired, async (req, res) => {
  const parsed = adminNoticeSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: validationMessage(parsed.error) });
    return;
  }
  const row = await prisma.hospital_notice
    .create({ data: { ...parsed.data, profile_id: String(req.params.id) } })
    .catch(() => null);
  if (row == null) {
    res.status(404).json({ message: "profile not found" });
    return;
  }
  res.status(201).json({ id: row.id });
});

