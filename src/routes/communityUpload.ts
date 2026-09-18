import crypto from "crypto";
import fs from "fs";
import path from "path";
import express from "express";
import multer from "multer";
import rateLimit from "express-rate-limit";

import prisma from "../lib/prisma";
import { requireMobileAuth } from "../lib/mobileAuth";

/**
 * 커뮤니티 글에 붙이는 사진.
 *
 * banner.ts 와 같은 방식이다 - 로컬 디스크에 두고 이 서버가 내준다. 다만
 * 거기는 관리자만 올리고, 여기는 가입한 누구나 올린다. 그래서 세 가지가 다르다.
 *
 * - 확장자를 파일 이름에서 가져오지 않는다. 이름도 mimetype 도 보내는 쪽이
 *   정하는 값이라, "x.html" 을 image/png 라고 적어 올리면 우리 도메인에서
 *   HTML 이 서빙된다. 허용한 세 형식에서 확장자를 정하면, 내용이 무엇이든
 *   이미지 타입으로만 나간다 (nosniff 는 nginx 가 붙인다).
 * - 사람마다 횟수를 센다. IP 로 세면 병원 와이파이 하나에 여럿이 묶인다.
 * - 글에는 여기서 나간 주소만 붙일 수 있다 (isCommunityImageUrl). 아무 주소나
 *   받으면 남의 서버 이미지로 읽는 사람을 추적할 수 있다.
 */

// ponytail: 로컬 디스크. 서버를 옮기면 uploads/ 도 함께 옮겨야 한다. 용량이
// 문제가 되거나 서버가 둘이 되면 오브젝트 스토리지로.
// ponytail: 파일은 지우지 않는다 - 글에서 빠진 사진은 아래 GET 이 내주지 않을
// 뿐 디스크에는 남는다. 디스크가 문제가 되면, 어느 살아 있는 글에도 없고
// 하루 넘게 지난 파일을 지우는 스크립트를 돌린다.
const UPLOAD_DIR = path.join(__dirname, "../../uploads/community");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// 앱이 이미 부르는 주소(myodoc app.json apiBaseUrl) 아래에 둔다. 거기로 가는
// 요청이 이 서버에 닿는 것은 이미 확인된 길이라, nginx 설정을 새로 믿을 일이 없다.
const PUBLIC_BASE = "https://myopiamanage.org/api/mobile/community/uploads/";

const EXT_BY_TYPE: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
};

/** 우리가 내준 주소인지. 파일 이름까지 우리가 짓는 꼴(uuid + 허용 확장자)이어야 한다. */
export function isCommunityImageUrl(url: string): boolean {
  if (!url.startsWith(PUBLIC_BASE)) return false;
  return /^[0-9a-f-]{36}\.(jpg|png|webp)$/.test(url.slice(PUBLIC_BASE.length));
}

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (_req, file, cb) => cb(null, `${crypto.randomUUID()}${EXT_BY_TYPE[file.mimetype]}`),
  }),
  // 앱이 1600px 로 줄여 보내면 수백 KB 다. 5MB 는 줄이지 않은 원본이 와도
  // 받아 주되, 그 이상은 무언가 잘못된 것이다.
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => cb(null, file.mimetype in EXT_BY_TYPE),
});

// 글 하나에 세 장. 쓰다 지우고 다시 고르는 것까지 넉넉히 두고, 봇이 디스크를
// 채우는 속도는 막는다.
const uploadLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 30,
  keyGenerator: (req) => req.mobileUser!.sub,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "사진을 너무 자주 올렸습니다. 잠시 후 다시 시도해 주세요." },
});

const router = express.Router();

/** POST /api/mobile/community/uploads — multipart, 필드 이름 "image". { url } 을 돌려준다. */
router.post(
  "/community/uploads",
  requireMobileAuth,
  uploadLimiter,
  upload.single("image"),
  (req, res) => {
    if (!req.file) {
      res.status(400).json({ error: "JPG·PNG·WEBP 사진만 올릴 수 있습니다." });
      return;
    }
    res.status(201).json({ url: PUBLIC_BASE + req.file.filename });
  },
);

/**
 * GET /api/mobile/community/uploads/:filename
 *
 * 살아 있는 글에 붙은 사진만 내준다. 로그인은 보지 않는다 - 글을 읽는 데
 * 로그인이 필요 없듯이.
 *
 * 주소만 알면 누구나 열 수 있으니, 글이 사라지면 사진도 함께 닫혀야 한다.
 * 아이 사진과 처방전이 올라오는 곳이다. 글이 사라지는 길은 여럿인데(작성자
 * 삭제, 신고로 숨김, 수정하며 사진을 뺌, 올려 놓고 글을 안 씀) 모두 결국
 * "이 주소를 가진 살아 있는 글이 없다"로 모인다. 그래서 길마다 파일을
 * 지우지 않고 여기 한 곳에서 본다.
 */
router.get("/community/uploads/:filename", async (req, res) => {
  const name = path.basename(String(req.params.filename));
  const live = await prisma.community_post.findFirst({
    where: { deleted_at: null, image_urls: { has: PUBLIC_BASE + name } },
    select: { id: true },
  });
  if (!live) {
    res.sendStatus(404);
    return;
  }
  // 오래 두면 글이 지워진 뒤에도 캐시에서 계속 보인다.
  res.sendFile(path.join(UPLOAD_DIR, name), { maxAge: "5m" }, (err) => {
    if (err && !res.headersSent) res.sendStatus(404);
  });
});

export default router;
