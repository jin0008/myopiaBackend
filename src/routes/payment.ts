import express from "express";
import zod from "zod";

import prisma from "../lib/prisma";
import { partnerRequired } from "../lib/partnerAuth";
import { siteAdminRequired } from "../lib/middlewares";
import { getPayment, isConfigured } from "../services/nicepay";

const router = express.Router();

/* ---- 웹훅 -------------------------------------------------------------
 *
 * 나이스가 결제 결과를 알려 주는 창구. 관리자 페이지에 이 주소를 등록한다.
 *
 *   https://myopiamanage.org/api/payment/nice/webhook
 *
 * 몸통을 믿지 않는다. 밖에서 아무나 쏠 수 있는 자리라, 거기 적힌 금액과
 * 상태를 그대로 믿으면 공짜로 구독을 켜는 길이 열린다. tid 만 받아 들고
 * 결제사에게 다시 물어, 돌아온 답을 기록한다.
 *
 * 서명을 맞춰 보는 방법도 있다. 그 쪽을 쓰지 않는 이유는, 서명 식을
 * 잘못 외우면 조용히 전부 통과하거나 전부 막히는데 둘 다 알아채기
 * 어렵기 때문이다. 다시 묻는 쪽은 틀릴 여지가 없다.
 */
router.post("/nice/webhook", async (req, res) => {
  // 나이스는 "OK" 를 못 받으면 같은 알림을 여러 번 보낸다. 처리에
  // 실패하더라도 200 을 주고, 못 쓴 것은 로그로 남긴다 - 재시도가
  // 쌓이는 것보다 우리가 다시 조회하는 쪽이 낫다.
  const tid = String((req.body as { tid?: unknown })?.tid ?? "");
  res.status(200).send("OK");

  if (tid === "") {
    console.error("[payment] 웹훅에 tid 가 없다", req.body);
    return;
  }
  try {
    await syncFromNice(tid);
  } catch (err) {
    console.error("[payment] 웹훅 처리 실패", tid, err);
  }
});

/**
 * 결제사에게 묻고 우리 기록을 맞춘다.
 *
 * 웹훅이 왔을 때와 사람이 "결제 확인"을 누를 때 같은 길을 쓴다. 두 벌로
 * 두면 한쪽만 고쳐져 상태가 갈린다.
 */
export async function syncFromNice(tid: string): Promise<void> {
  const r = await getPayment(tid);
  const orderId = String(r.orderId ?? "");
  if (orderId === "") return;

  const row = await prisma.payment.findUnique({ where: { order_id: orderId } });
  if (row == null) {
    // 우리가 만들지 않은 주문이다. 남의 상점 알림이거나 위조다.
    console.error("[payment] 모르는 주문번호", orderId, tid);
    return;
  }

  const paid = r.resultCode === "0000" && r.status === "paid";
  // 금액이 다르면 성공으로 보지 않는다. 결제창에서 금액을 바꿔 넣는
  // 수법이 있는데, 우리가 적어 둔 금액과 맞춰 보면 걸린다.
  const amountOk = Number(r.amount ?? -1) === row.amount;

  await prisma.payment.update({
    where: { id: row.id },
    data: {
      tid,
      status: paid && amountOk ? "paid" : "failed",
      pay_method: typeof r.payMethod === "string" ? r.payMethod : null,
      paid_at: paid && amountOk ? new Date() : null,
      failed_reason: paid
        ? amountOk
          ? null
          : "결제 금액이 주문 금액과 다릅니다."
        : r.resultMsg,
      raw: r as object,
      updated_at: new Date(),
    },
  });

  if (!(paid && amountOk) || row.subscription_id == null) return;

  // 돈이 들어왔으니 주기를 한 달 민다. 끝나는 날부터 더한다 - 오늘부터
  // 더하면 일찍 낸 사람이 손해를 본다.
  const sub = await prisma.subscription.findUnique({
    where: { id: row.subscription_id },
  });
  if (sub == null) return;
  const from = sub.current_period_end > new Date() ? sub.current_period_end : new Date();
  const next = new Date(from);
  next.setMonth(next.getMonth() + 1);
  await prisma.subscription.update({
    where: { id: sub.id },
    data: { status: "active", current_period_end: next, updated_at: new Date() },
  });
}

/* ---- 파트너 ----------------------------------------------------------- */

/** 내 구독 상태. 결제가 아직 안 붙어 있으면 그 사실을 알려 준다. */
router.get("/me", partnerRequired, async (req, res) => {
  const [sub, payments] = await Promise.all([
    prisma.subscription.findUnique({ where: { account_id: req.partner!.sub } }),
    prisma.payment.findMany({
      where: { account_id: req.partner!.sub },
      orderBy: { created_at: "desc" },
      take: 12,
    }),
  ]);
  res.json({
    // 결제 설정이 안 되어 있으면 화면이 "구독하기"를 띄워 봐야 눌러도
    // 아무 일이 없다. 그 사실을 숨기지 않는다.
    available: isConfigured(),
    subscription:
      sub == null
        ? null
        : {
            plan: sub.plan,
            status: sub.status,
            currentPeriodEnd: sub.current_period_end.toISOString(),
            amount: sub.amount,
            canceledAt: sub.canceled_at?.toISOString() ?? null,
          },
    payments: payments.map((p) => ({
      id: p.id,
      orderId: p.order_id,
      amount: p.amount,
      status: p.status,
      payMethod: p.pay_method,
      paidAt: p.paid_at?.toISOString() ?? null,
      failedReason: p.failed_reason,
      createdAt: p.created_at.toISOString(),
    })),
  });
});

/* ---- 운영자 ----------------------------------------------------------- */

/** 결제 내역. 돈 이야기가 나오면 여기부터 본다. */
router.get("/", siteAdminRequired, async (_req, res) => {
  const rows = await prisma.payment.findMany({
    orderBy: { created_at: "desc" },
    take: 200,
    include: {
      account: { select: { id: true, hospital_name: true, email: true } },
    },
  });
  res.json(
    rows.map((p) => ({
      id: p.id,
      orderId: p.order_id,
      tid: p.tid,
      amount: p.amount,
      status: p.status,
      payMethod: p.pay_method,
      paidAt: p.paid_at?.toISOString() ?? null,
      failedReason: p.failed_reason,
      createdAt: p.created_at.toISOString(),
      account: {
        id: p.account.id,
        hospitalName: p.account.hospital_name,
        email: p.account.email,
      },
    })),
  );
});

const syncSchema = zod.object({ tid: zod.string().min(1) });

/**
 * 손으로 다시 맞춘다.
 *
 * 웹훅을 놓치는 일은 생긴다 - 배포 중이었거나, 네트워크가 끊겼거나.
 * 그때 운영자가 거래번호 하나로 바로잡을 수 있어야 한다. 없으면 DB 를
 * 직접 고치게 된다.
 */
router.post("/sync", siteAdminRequired, async (req, res) => {
  const parsed = syncSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "거래번호(tid)를 적어 주세요." });
    return;
  }
  try {
    await syncFromNice(parsed.data.tid);
    res.sendStatus(204);
  } catch (err) {
    console.error("[payment] 수동 동기화 실패", err);
    res.status(502).json({ message: "결제사에 물어보지 못했습니다." });
  }
});

export default router;
