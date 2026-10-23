import crypto from "crypto";
import fs from "fs";
import path from "path";
import express from "express";
import multer from "multer";
import zod from "zod";
import prisma from "../lib/prisma";
import { siteAdminRequired } from "../lib/middlewares";

const router = express.Router();

const createSchema = zod.object({
  title: zod.string().min(1),
  /// 목록 카드용. 비우면 title 을 쓴다.
  short_title: zod.string().max(40).nullable().optional(),
  body: zod.string().min(1),
  category: zod.string().min(1),
  author: zod.string().min(1).optional(),
  author_role: zod.string().min(1).optional(),
  thumbnail_emoji: zod.string().min(1).optional(),
  published: zod.boolean().optional(),
});
const patchSchema = createSchema.partial();

// 칼럼 본문 속 이미지. 어드민 편집기가 올린 것과, 네이버 카페 글을 옮기며
// 받아 둔 것(scripts/import-naver-cafe.ts) - 카페 이미지는 우리 도메인에서
// 걸면 403 이라 그대로 링크할 수 없다.
const UPLOAD_DIR = path.join(__dirname, "../../uploads/columns");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// 확장자는 파일 이름이 아니라 허용한 형식에서 정한다. 이름도 mimetype 도
// 보내는 쪽이 정하는 값이라, "x.svg"·"x.html" 을 image/png 로 올리면 우리
// 도메인에서 스크립트가 도는 문서가 된다 (communityUpload.ts 와 같은 이유).
const EXT_BY_TYPE: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
};

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (_req, file, cb) => cb(null, `${crypto.randomUUID()}${EXT_BY_TYPE[file.mimetype]}`),
  }),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB - 큰 사진은 어드민이 줄여서 보낸다
  fileFilter: (_req, file, cb) => cb(null, file.mimetype in EXT_BY_TYPE),
});

// POST /column/upload — admin, multipart/form-data field "image".
// 본문에 ![](url) 로 넣을 주소를 돌려준다.
router.post("/upload", siteAdminRequired, upload.single("image"), (req, res) => {
  if (!req.file) {
    res.status(400).json({ message: "no image file (or not an image)" });
    return;
  }
  res.status(201).json({
    url: `https://myopiamanage.org/api/column/uploads/${req.file.filename}`,
  });
});

// GET /column/uploads/:filename — public.
router.get("/uploads/:filename", (req, res) => {
  res.sendFile(path.join(UPLOAD_DIR, path.basename(req.params.filename)), (err) => {
    if (err) res.sendStatus(404);
  });
});

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
      short_title: d.short_title ?? null,
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
