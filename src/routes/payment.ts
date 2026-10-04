import express from "express";
import zod from "zod";

import prisma from "../lib/prisma";
import { partnerRequired } from "../lib/partnerAuth";
import { extendSubscription } from "../services/subscription";
import { siteAdminRequired } from "../lib/middlewares";
import {
  approvePayment,
  cancelPayment,
  clientKey,
  expireBilling,
  getPayment,
  isConfigured,
  registerBilling,
} from "../services/nicepay";

/** 결제가 끝나면 돌아갈 자리. */
const PARTNER_ORIGIN = "https://myopiamanage.org";
/** 나이스가 인증 결과를 보내는 주소. 결제창에 그대로 넘긴다. */
const RETURN_URL = `${PARTNER_ORIGIN}/api/payment/nice/return`;

const router = express.Router();

/* ---- 결제창 ----------------------------------------------------------
 *
 * 흐름이 셋으로 나뉜다.
 *
 *   1. checkout  — 우리가 주문을 만든다(금액을 서버가 정한다)
 *   2. 결제창     — 브라우저가 나이스 창을 열고 카드 인증을 받는다
 *   3. return    — 나이스가 인증 결과를 우리 서버로 보낸다. 여기서 승인한다
 *
 * 인증과 승인은 다르다. 인증까지는 카드사가 "이 사람 맞다"고 한 것이고
 * 돈은 승인에서 빠진다. 인증 결과만 보고 구독을 켜면 돈을 안 받고 켜 주는
 * 셈이 된다.
 */

const checkoutSchema = zod.object({
  months: zod.number().int().min(1).max(12),
});

/** 한 달 구독료(원). 값이 정해지면 설정으로 뺀다. */
const MONTHLY_AMOUNT = Number(process.env.SUBSCRIPTION_MONTHLY_AMOUNT ?? 100);

/**
 * 주문을 만든다. 금액은 서버가 정한다.
 *
 * 화면이 보낸 금액을 그대로 쓰면, 개발자 도구로 100원이라고 적어 보내는
 * 것을 막을 수 없다. 화면은 몇 달치인지만 말한다.
 */
router.post("/checkout", partnerRequired, async (req, res) => {
  if (!isConfigured()) {
    res.status(503).json({ message: "결제 준비가 아직 되지 않았습니다." });
    return;
  }
  const parsed = checkoutSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "개월 수를 확인해 주세요." });
    return;
  }
  const accountId = req.partner!.sub;

  // 업체가 묶이지 않은 계정은 광고를 걸 곳이 없다. 돈부터 받고 나서
  // "그런데 어느 가게죠"를 물으면 안 된다.
  const account = await prisma.hospital_account.findUnique({
    where: { id: accountId },
    select: { facility_key: true, hospital_name: true },
  });
  if (account?.facility_key == null) {
    res.status(403).json({
      code: "facility_not_linked",
      message: "업체 인증을 먼저 마쳐 주세요.",
    });
    return;
  }

  const months = parsed.data.months;
  const amount = MONTHLY_AMOUNT * months;
  // 주문번호는 우리가 만든다. 같은 번호로 두 번 승인되지 않는다(unique).
  const orderId = `sub_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

  await prisma.payment.create({
    data: { account_id: accountId, order_id: orderId, amount, months, status: "pending" },
  });

  res.json({
    clientId: clientKey(),
    orderId,
    amount,
    goodsName: `마이오닥 프리미엄 ${months}개월`,
    returnUrl: RETURN_URL,
  });
});

/**
 * 나이스가 인증 결과를 보내는 자리.
 *
 * 폼으로 온다(JSON 아님). 그리고 사람의 브라우저가 따라오므로, 끝나면
 * 파트너 화면으로 돌려보내야 한다 - JSON 을 뱉으면 사용자는 흰 화면에
 * 글자만 보게 된다.
 */
router.post(
  "/nice/return",
  express.urlencoded({ extended: false }),
  async (req, res) => {
    const b = req.body as Record<string, string>;
    const orderId = String(b.orderId ?? "");
    const tid = String(b.tid ?? "");
    const back = (ok: boolean, reason?: string) =>
      res.redirect(
        302,
        `${PARTNER_ORIGIN}/partner/promotions?pay=${ok ? "ok" : "fail"}` +
          (reason ? `&reason=${encodeURIComponent(reason)}` : ""),
      );

    const row =
      orderId === "" ? null : await prisma.payment.findUnique({ where: { order_id: orderId } });
    if (row == null) {
      // 우리가 만들지 않은 주문이다. 남의 상점 알림이거나 위조다.
      console.error("[payment] 모르는 주문번호", orderId, tid);
      return back(false, "주문을 찾을 수 없습니다.");
    }
    if (row.status === "paid") {
      // 두 번 들어왔다. 이미 끝난 일이라 그대로 성공으로 돌려보낸다.
      return back(true);
    }

    if (String(b.authResultCode ?? "") !== "0000") {
      await prisma.payment.update({
        where: { id: row.id },
        data: {
          status: "failed",
          tid: tid || null,
          failed_reason: String(b.authResultMsg ?? "카드 인증에 실패했습니다."),
          raw: b as object,
          updated_at: new Date(),
        },
      });
      return back(false, String(b.authResultMsg ?? "카드 인증에 실패했습니다."));
    }

    // 금액은 우리가 적어 둔 것으로 승인한다. 결제창에서 바꿔 넣어도
    // 그 금액으로는 승인되지 않는다.
    try {
      const r = await approvePayment(tid, row.amount);
      await prisma.payment.update({
        where: { id: row.id },
        data: {
          tid,
          status: "paid",
          pay_method: typeof r.payMethod === "string" ? r.payMethod : null,
          paid_at: new Date(),
          failed_reason: null,
          raw: r as object,
          updated_at: new Date(),
        },
      });
      await extendSubscription(row.account_id, row.id, row.amount, row.months);
      return back(true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "승인에 실패했습니다.";
      console.error("[payment] 승인 실패", orderId, tid, err);
      await prisma.payment.update({
        where: { id: row.id },
        data: { tid, status: "failed", failed_reason: msg, updated_at: new Date() },
      });
      return back(false, msg);
    }
  },
);

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
  // 이미 끝낸 결제다. 결제창에서 돌아올 때 승인하고 구독을 밀었는데,
  // 웹훅이 같은 건으로 또 오면 두 번 밀린다 - 한 번 낸 돈으로 두 달을
  // 받는 셈이다. 기록만 맞추고 손대지 않는다.
  if (row.status === "paid" || row.status === "canceled") {
    await prisma.payment.update({
      where: { id: row.id },
      data: { tid, raw: r as object, updated_at: new Date() },
    });
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

  if (!(paid && amountOk)) return;

  // 결제창을 거치지 않고 웹훅만 먼저 오는 경우(가상계좌 입금 등)가 있다.
  // 그때도 같은 함수를 쓴다 - 두 벌로 두면 한쪽만 고쳐져 기간이 갈린다.
  await extendSubscription(row.account_id, row.id, row.amount, row.months);
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
            // 카드가 등록돼 있는지와, 매달 빼 가도 된다는 허락은 다르다.
            // 둘을 한 값으로 합치면 "카드는 남았는데 갱신은 꺼진" 상태를
            // 화면이 말할 수 없다.
            cardRegistered: sub.billing_key != null,
            autoRenew: sub.auto_renew,
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

const cancelSchema = zod.object({
  reason: zod.string().trim().min(1).max(100),
});

/**
 * 승인을 취소한다.
 *
 * 당일 취소면 카드사가 매입을 올리지 않아 실제로 청구되지 않는다. 테스트
 * 결제를 지우는 자리이자, 잘못 받은 돈을 돌려주는 자리다.
 *
 * 구독은 되돌리지 않는다. 한 달을 밀어 둔 것을 자동으로 빼면, 다른 달
 * 결제까지 섞여 있을 때 어느 몫을 빼야 하는지 알 수 없다 - 운영자가
 * 보고 정할 일이다.
 */
router.post("/:id/cancel", siteAdminRequired, async (req, res) => {
  const parsed = cancelSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "취소 사유를 적어 주세요." });
    return;
  }
  const row = await prisma.payment.findUnique({ where: { id: String(req.params.id) } });
  if (row == null) {
    res.sendStatus(404);
    return;
  }
  if (row.status !== "paid" || row.tid == null) {
    res.status(409).json({ message: "승인된 결제만 취소할 수 있습니다." });
    return;
  }
  try {
    // 취소도 주문번호가 필요하다. 같은 번호로 두 번 취소되지 않게 한다.
    const r = await cancelPayment({
      tid: row.tid,
      reason: parsed.data.reason,
      orderId: `cancel_${row.order_id}`,
    });
    await prisma.payment.update({
      where: { id: row.id },
      data: {
        status: "canceled",
        failed_reason: parsed.data.reason,
        raw: r as object,
        updated_at: new Date(),
      },
    });
    res.sendStatus(204);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "취소하지 못했습니다.";
    console.error("[payment] 취소 실패", row.order_id, err);
    res.status(502).json({ message: msg });
  }
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

/* ---- 자동 갱신 ------------------------------------------------------
 *
 * 카드를 한 번 등록해 두고(빌링키) 매달 그것으로 청구한다. 카드번호는
 * 우리가 들지 않는다 - 들면 PCI 범위에 들어오고, 그럴 이유가 없다.
 *
 * 등록과 청구는 다른 허락이다. 카드를 넣었다고 매달 빼 가도 된다는 뜻은
 * 아니라서, auto_renew 를 따로 둔다.
 */

/**
 * 카드 등록을 시작한 주문번호 → 계정.
 *
 * 결제창은 우리 쿠키를 들고 오지 않아, 돌아왔을 때 누구인지 알 방법이
 * 주문번호뿐이다. 계정 번호를 브라우저에 실어 보내고 그대로 믿으면, 남의
 * 계정 번호를 적어 넣어 그 구독에 자기 카드를 붙일 수 있다.
 *
 * 서버에 둔다. 재시작하면 날아가지만, 그 사이 등록 중이던 사람만 한 번
 * 다시 하면 되는 일이라 표를 하나 더 만들 값어치는 없다.
 */
const pendingCards = new Map<string, { accountId: string; at: number }>();
const CARD_TTL_MS = 10 * 60 * 1000;

function rememberCardOrder(orderId: string, accountId: string): void {
  const now = Date.now();
  for (const [k, v] of pendingCards) {
    if (now - v.at > CARD_TTL_MS) pendingCards.delete(k);
  }
  pendingCards.set(orderId, { accountId, at: now });
}

/** 카드 등록창을 연다. 돈은 빠지지 않는다. */
router.post("/billing/register", partnerRequired, async (req, res) => {
  if (!isConfigured()) {
    res.status(503).json({ message: "결제 준비가 아직 되지 않았습니다." });
    return;
  }
  const accountId = req.partner!.sub;
  const account = await prisma.hospital_account.findUnique({
    where: { id: accountId },
    select: { facility_key: true, hospital_name: true },
  });
  if (account?.facility_key == null) {
    res.status(403).json({
      code: "facility_not_linked",
      message: "업체 인증을 먼저 마쳐 주세요.",
    });
    return;
  }
  const orderId = `bill_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  rememberCardOrder(orderId, accountId);
  res.json({
    clientId: clientKey(),
    orderId,
    goodsName: "마이오닥 프리미엄 정기결제",
    returnUrl: `${PARTNER_ORIGIN}/api/payment/nice/billing-return`,
  });
});

/**
 * 카드 등록 결과.
 *
 * 나이스가 어떤 모양으로 돌려주는지는 상점마다 설정이 갈린다. 빌링키를
 * 바로 주기도 하고, 인증만 끝내 놓고 발급은 따로 부르게 하기도 한다.
 * 그래서 몸통을 통째로 남긴다 - 처음 한 번은 로그를 보고 맞춰야 한다.
 */
router.post(
  "/nice/billing-return",
  express.urlencoded({ extended: false }),
  async (req, res) => {
    const b = req.body as Record<string, string>;
    const back = (ok: boolean, reason?: string) =>
      res.redirect(
        302,
        `${PARTNER_ORIGIN}/partner/promotions?card=${ok ? "ok" : "fail"}` +
          (reason ? `&reason=${encodeURIComponent(reason)}` : ""),
      );

    console.log("[payment] 카드 등록 결과", JSON.stringify(b));

    const authOk = String(b.authResultCode ?? "") === "0000";
    if (!authOk) {
      return back(false, String(b.authResultMsg ?? "카드 인증에 실패했습니다."));
    }

    // 결제창이 빌링키를 바로 주면 그것을 쓰고, 안 주면 거래번호로 발급을
    // 부른다. 둘 다 아니면 로그를 보고 맞춘다.
    let bid = String(b.bid ?? "");
    if (bid === "") {
      const tid = String(b.tid ?? "");
      if (tid === "") return back(false, "빌링키를 받지 못했습니다.");
      try {
        const r = await registerBilling(tid);
        bid = String(r.bid ?? "");
      } catch (err) {
        const msg = err instanceof Error ? err.message : "카드 등록에 실패했습니다.";
        console.error("[payment] 빌링키 발급 실패", tid, err);
        return back(false, msg);
      }
    }
    if (bid === "") return back(false, "빌링키를 받지 못했습니다.");

    // 우리가 시작한 등록인지 주문번호로 확인한다.
    const pending = pendingCards.get(String(b.orderId ?? ""));
    if (pending == null) {
      console.error("[payment] 모르는 카드 등록", JSON.stringify(b));
      return back(false, "등록 시간이 지났습니다. 다시 해 주세요.");
    }
    pendingCards.delete(String(b.orderId ?? ""));
    const accountId = pending.accountId;

    const now = new Date();
    const sub = await prisma.subscription.findUnique({
      where: { account_id: accountId },
    });
    if (sub == null) {
      // 아직 한 번도 결제하지 않은 곳이다. 카드만 걸어 두고 주기는
      // 비워 둔다 - 오늘부터 한 달로 잡으면 돈을 안 받고 광고가 나간다.
      await prisma.subscription.create({
        data: {
          account_id: accountId,
          status: "active",
          current_period_end: now,
          amount: MONTHLY_AMOUNT,
          billing_key: bid,
          auto_renew: true,
        },
      });
    } else {
      await prisma.subscription.update({
        where: { id: sub.id },
        data: {
          billing_key: bid,
          auto_renew: true,
          canceled_at: null,
          failed_count: 0,
          updated_at: now,
        },
      });
    }
    return back(true);
  },
);

/**
 * 자동 갱신을 끈다.
 *
 * 광고를 바로 내리지 않는다 - 이번 주기까지는 돈을 받았다. 여기서 하는
 * 일은 다음 청구를 막는 것까지다.
 */
router.post("/subscription/cancel", partnerRequired, async (req, res) => {
  const sub = await prisma.subscription.findUnique({
    where: { account_id: req.partner!.sub },
  });
  if (sub == null) {
    res.status(404).json({ message: "구독이 없습니다." });
    return;
  }
  if (sub.billing_key != null) {
    try {
      await expireBilling(sub.billing_key, `cancel_${Date.now().toString(36)}`);
    } catch (err) {
      // 결제사 쪽에서 못 지웠어도 우리 쪽 스위치는 내린다. 켜 둔 채로
      // 두면 다음 달에 청구가 나간다 - 끊겠다고 한 사람에게서.
      console.error("[payment] 빌링키 삭제 실패", sub.id, err);
    }
  }
  await prisma.subscription.update({
    where: { id: sub.id },
    data: {
      auto_renew: false,
      billing_key: null,
      canceled_at: new Date(),
      updated_at: new Date(),
    },
  });
  res.json({
    ok: true,
    until: sub.current_period_end.toISOString(),
  });
});

export default router;
