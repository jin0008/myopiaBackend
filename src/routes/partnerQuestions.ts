import express from "express";
import zod from "zod";
import prisma from "../lib/prisma";
import { partnerRequired } from "../lib/partnerAuth";
import { validateRequestBody } from "../lib/middlewares";
import { notify } from "../lib/notify";
import { answerEligibility } from "../services/subscription";

/**
 * 파트너 웹의 '질문 답변'. 앱 커뮤니티 '시술/수술 질문'(category = "general")에
 * 프리미엄 구독 안과가 병원 이름으로 답한다. 앱 회원은 이 게시판에 댓글을 달 수
 * 없다(mobile.ts) - 질문은 보호자가, 답은 병원이 한다.
 *
 * 보기는 승인된 파트너 누구나, 쓰기는 answerEligibility 를 통과한 병원만.
 * 구독이 끝나도 이미 단 답변은 남는다(지우면 질문한 사람이 받은 답이 사라진다).
 */
const router = express.Router();
router.use(partnerRequired);

const QUESTION = "general";
const PAGE = 20;

const NOT_ELIGIBLE: Record<string, string> = {
  not_eye_hospital: "안과 병원만 답변할 수 있습니다.",
  not_approved: "승인된 병원만 답변할 수 있습니다.",
  no_subscription: "프리미엄 구독 중인 병원만 답변할 수 있습니다.",
};

/** GET /partner/questions?cursor= — 최근 질문. 내가 답했는지와 답변 수를 함께. */
router.get("/", async (req, res) => {
  const me = req.partner!.sub;
  const cursor = typeof req.query.cursor === "string" ? req.query.cursor : undefined;
  const rows = await prisma.community_post.findMany({
    where: { category: QUESTION, deleted_at: null },
    orderBy: [{ created_at: "desc" }, { id: "desc" }],
    take: PAGE + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    select: {
      id: true,
      title: true,
      body: true,
      created_at: true,
      answers: { where: { deleted_at: null }, select: { hospital_account_id: true } },
    },
  });
  const page = rows.slice(0, PAGE);
  res.json({
    eligibility: await answerEligibility(me),
    questions: page.map((p) => ({
      id: p.id,
      title: p.title,
      preview: p.body.replace(/\s+/g, " ").slice(0, 120),
      createdAt: p.created_at.toISOString(),
      answerCount: p.answers.length,
      answeredByMe: p.answers.some((a) => a.hospital_account_id === me),
    })),
    nextCursor: rows.length > PAGE ? page[page.length - 1].id : null,
  });
});

/** GET /partner/questions/:id — 질문 본문과 병원 답변들. 보호자 닉네임은 보이지 않는다. */
router.get("/:id", async (req, res) => {
  const me = req.partner!.sub;
  const post = await prisma.community_post.findFirst({
    where: { id: String(req.params.id), category: QUESTION, deleted_at: null },
    select: {
      id: true,
      title: true,
      body: true,
      image_urls: true,
      created_at: true,
      answers: {
        where: { deleted_at: null },
        orderBy: { created_at: "asc" },
        select: {
          id: true,
          body: true,
          created_at: true,
          updated_at: true,
          hospital_account_id: true,
          account: { select: { hospital_name: true } },
        },
      },
    },
  });
  if (post == null) {
    res.status(404).json({ error: "질문을 찾을 수 없습니다." });
    return;
  }
  res.json({
    eligibility: await answerEligibility(me),
    question: {
      id: post.id,
      title: post.title,
      body: post.body,
      imageUrls: post.image_urls,
      createdAt: post.created_at.toISOString(),
    },
    answers: post.answers.map((a) => ({
      id: a.id,
      hospitalName: a.account.hospital_name,
      body: a.body,
      createdAt: a.created_at.toISOString(),
      updatedAt: a.updated_at.toISOString(),
      mine: a.hospital_account_id === me,
    })),
  });
});

const answerSchema = zod.object({ body: zod.string().trim().min(1).max(3_000) });

/**
 * PUT /partner/questions/:id/answer — 내 답변을 쓰거나 고친다. 병원 하나에 질문
 * 하나당 답변 하나라 POST/PATCH 를 나누지 않는다.
 */
router.put("/:id/answer", validateRequestBody(answerSchema), async (req, res) => {
  const me = req.partner!.sub;
  const eligible = await answerEligibility(me);
  if (!eligible.ok) {
    res.status(403).json({ error: NOT_ELIGIBLE[eligible.reason], code: eligible.reason });
    return;
  }
  const post = await prisma.community_post.findFirst({
    where: { id: String(req.params.id), category: QUESTION, deleted_at: null },
    select: { id: true, user_id: true, title: true },
  });
  if (post == null) {
    res.status(404).json({ error: "질문을 찾을 수 없습니다." });
    return;
  }
  const { body } = req.body as zod.infer<typeof answerSchema>;
  const existing = await prisma.community_answer.findUnique({
    where: { post_id_hospital_account_id: { post_id: post.id, hospital_account_id: me } },
  });
  // 운영자가 숨긴 답변을 병원이 고쳐 되살리지 못하게 한다.
  if (existing?.deleted_at != null) {
    res.status(403).json({ error: "운영 정책에 따라 숨겨진 답변이 있어 새로 쓸 수 없습니다." });
    return;
  }
  const saved = existing
    ? await prisma.community_answer.update({ where: { id: existing.id }, data: { body } })
    : await prisma.community_answer.create({
        data: { post_id: post.id, hospital_account_id: me, body },
      });

  // 처음 답할 때만 질문한 사람에게 알린다. 고칠 때마다 울리면 시끄럽다.
  if (existing == null) {
    await notify({
      userId: post.user_id,
      actorUserId: null,
      type: "hospital_answer",
      targetType: "post",
      targetId: post.id,
      title: post.title,
      preview: `${eligible.hospitalName}: ${body}`,
    });
  }
  res.status(existing ? 200 : 201).json({ id: saved.id });
});

/** DELETE /partner/questions/:id/answer — 내 답변을 지운다(줄째로). */
router.delete("/:id/answer", async (req, res) => {
  const me = req.partner!.sub;
  const r = await prisma.community_answer.deleteMany({
    where: { post_id: String(req.params.id), hospital_account_id: me, deleted_at: null },
  });
  res.sendStatus(r.count > 0 ? 204 : 404);
});

export default router;
