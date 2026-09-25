import express from "express";
import zod from "zod";

import prisma from "../lib/prisma";
import { siteAdminRequired } from "../lib/middlewares";

const router = express.Router();

const KINDS = ["optical", "eye", "company"] as const;

const createSchema = zod.object({
  kind: zod.enum(KINDS),
  org: zod.string().trim().min(1).max(100),
  contactName: zod.string().trim().min(1).max(50),
  phone: zod.string().trim().min(9).max(30),
  email: zod.string().trim().email().max(120),
  memo: zod.string().trim().max(1000).optional(),
  agreed: zod.literal(true),
  /** 허니팟. 사람에게는 보이지 않는 칸이라 비어 있어야 한다.
   *
   *  여기서 길이를 막지 않는다. zod 가 먼저 400 으로 거절해 버리면 아래
   *  "조용히 삼키는" 처리가 영영 실행되지 않는다 - 봇은 400 을 보고 무엇에
   *  걸렸는지 알아낸다. 값을 받아 두고 아래에서 판단한다. */
  website: zod.string().max(200).optional(),
});

/**
 * POST /api/ad-inquiry — 광고 문의 접수.
 *
 * 로그인 없이 받는 유일한 쓰기 경로다. 막는 것이 두 겹이다.
 *  1) 경로에 걸린 리미터(index.ts) - 시간당 IP 당 5건
 *  2) 허니팟 - 화면에서 감춘 칸에 값이 차면 봇이다
 *
 * 허니팟에 걸린 요청도 201 로 답한다. 400 을 주면 봇이 무엇에 걸렸는지 알고
 * 다음번엔 그 칸을 비우고 온다.
 */
router.post("/", async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "입력을 확인해 주세요." });
    return;
  }
  const b = parsed.data;

  if (b.website != null && b.website !== "") {
    res.status(201).json({ ok: true });
    return;
  }

  await prisma.ad_inquiry.create({
    data: {
      kind: b.kind,
      org: b.org,
      contact_name: b.contactName,
      phone: b.phone,
      email: b.email,
      memo: b.memo || null,
      // 화면에서 동의를 받아야만 보낼 수 있다. 그 사실을 시각으로 남긴다 -
      // "동의했다"는 불린만 남기면 언제 어느 문안에 동의했는지 알 수 없다.
      agreed_at: new Date(),
    },
  });
  res.status(201).json({ ok: true });
});

/** GET /api/ad-inquiry — 운영자 목록. 처리 안 된 것부터 최근 순. */
router.get("/", siteAdminRequired, async (req, res) => {
  const status = typeof req.query.status === "string" ? req.query.status : "";
  const rows = await prisma.ad_inquiry.findMany({
    where: status === "" ? {} : { status },
    orderBy: [{ created_at: "desc" }],
    take: 200,
  });
  res.json({
    inquiries: rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      org: r.org,
      contactName: r.contact_name,
      phone: r.phone,
      email: r.email,
      memo: r.memo,
      status: r.status,
      note: r.note,
      createdAt: r.created_at.toISOString(),
    })),
  });
});

const patchSchema = zod.object({
  status: zod.enum(["new", "contacted", "closed", "spam"]).optional(),
  note: zod.string().trim().max(500).nullable().optional(),
});

/** PATCH /api/ad-inquiry/:id — 운영자가 처리 상태를 바꾼다. */
router.patch("/:id", siteAdminRequired, async (req, res) => {
  const parsed = patchSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "입력을 확인해 주세요." });
    return;
  }
  const row = await prisma.ad_inquiry
    .update({
      where: { id: String(req.params.id) },
      data: { ...parsed.data, updated_at: new Date() },
    })
    .catch(() => null);
  if (row == null) {
    res.sendStatus(404);
    return;
  }
  res.json({ id: row.id, status: row.status, note: row.note });
});

export default router;
