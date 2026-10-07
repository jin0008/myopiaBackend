import express from "express";
import zod from "zod";

import prisma from "../lib/prisma";
import { partnerRequired } from "../lib/partnerAuth";
import { extendSubscription } from "../services/subscription";
import { GOODS_NAME, MONTHLY_AMOUNT, isPriced } from "../lib/pricing";
import { siteAdminRequired } from "../lib/middlewares";
import {
  NiceError,
  approvePayment,
  cancelPayment,
  chargeBilling,
  clientKey,
  expireBilling,
  getPayment,
  isConfigured,
  registerBilling,
} from "../services/nicepay";
import { billingLimiter } from "../lib/security";
import { newOrderId, whyNotSellable } from "../services/billing";

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

/**
 * 주문을 만든다. 금액은 서버가 정한다.
 *
 * 화면이 보낸 금액을 그대로 쓰면, 개발자 도구로 100원이라고 적어 보내는
 * 것을 막을 수 없다. 화면은 몇 달치인지만 말한다.
 */
router.post("/checkout", partnerRequired, async (req, res) => {
  if (!isConfigured() || !isPriced()) {
    // 값이 설정되지 않은 서버에서는 팔지 않는다. 기본값으로 긁으면 업체가
    // 본 값과 빠진 값이 달라진다.
    res.status(503).json({ message: "결제 준비가 아직 되지 않았습니다." });
    return;
  }
  const parsed = checkoutSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "개월 수를 확인해 주세요." });
    return;
  }
  const accountId = req.partner!.sub;
  const months = parsed.data.months;
  const blocked = await whyNotSellable(accountId);
  if (blocked != null) {
    res.status(blocked.status).json(blocked.body);
    return;
  }

  const amount = MONTHLY_AMOUNT * months;
  const orderId = newOrderId("sub");

  await prisma.payment.create({
    data: { account_id: accountId, order_id: orderId, amount, months, status: "pending" },
  });

  res.json({
    clientId: clientKey(),
    orderId,
    amount,
    goodsName: `${GOODS_NAME} ${months}개월`,
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
    // 값이 없으면 결제 버튼도 보이지 않는다. 눌러도 503 이 날 뿐이다.
    available: isConfigured() && isPriced(),
    billingAvailable: billingEnabled(),
    subscription:
      sub == null
        ? null
        : {
            plan: sub.plan,
            status: sub.status,
            currentPeriodEnd: sub.current_period_end.toISOString(),
            amount: sub.amount,
            canceledAt: sub.canceled_at?.toISOString() ?? null,
            // 카드가 등록되어 매달 빠져나가는 중인가.
            autoRenew: sub.auto_renew && sub.billing_key != null,
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

/* ---- 정기결제(빌링) ----------------------------------------------------
 *
 *   1. 카드 등록  — 카드 정보를 암호화해 나이스로 보내 빌키(bid)를 받는다
 *   2. 첫 달 청구 — 받은 빌키로 바로 한 달치를 청구한다
 *   3. 매달 청구  — 기간이 끝나 가면 같은 빌키로 다시 청구한다(별도 작업)
 *
 * 카드 정보는 1번 한 번만 이 서버를 지난다. 저장하지 않고 로그에도 남기지
 * 않는다. 남는 것은 빌키뿐이다.
 *
 * 나이스가 빌링을 열어 주기 전에는(결제 경로 심사) 운영 키로 등록이 되지
 * 않는다. NICEPAY_BILLING_ENABLED=1 일 때만 화면에 내놓는다.
 */

/** 정기결제를 팔 수 있나. 꺼져 있으면 화면이 카드 등록을 띄우지 않는다. */
function billingEnabled(): boolean {
  return isConfigured() && isPriced() && process.env.NICEPAY_BILLING_ENABLED === "1";
}

const cardSchema = zod.object({
  cardNo: zod.string().regex(/^\d{14,16}$/),
  expYear: zod.string().regex(/^\d{2}$/),
  expMonth: zod.string().regex(/^(0[1-9]|1[0-2])$/),
  // 개인카드는 생년월일 6자리, 법인카드는 사업자등록번호 10자리.
  idNo: zod.string().regex(/^(\d{6}|\d{10})$/),
  cardPw: zod.string().regex(/^\d{2}$/),
  // 매달 빠져나간다는 데 동의했다는 표시. 카드를 받았다고 매달 빼 가도
  // 된다는 뜻은 아니다 - 그 허락은 따로 받는다.
  agree: zod.literal(true),
});

/**
 * 카드를 등록하고 첫 달을 청구한다.
 *
 * 카드만 등록하고 청구는 다음 달부터 하는 길을 두지 않는다. 그러면 돈을
 * 받기 전에 광고가 걸리거나, 걸지 않으면 "등록했는데 왜 안 뜨냐"를 듣는다.
 *
 * 첫 청구가 실패하면 받은 빌키를 지운다. 남겨 두면 쓰지 않는 카드 연결이
 * 나이스에 쌓이고, 나중에 누군가 그 빌키로 청구할 수도 있다.
 */
router.post("/billing", partnerRequired, billingLimiter, async (req, res) => {
  if (!billingEnabled()) {
    res.status(503).json({ message: "정기결제는 아직 준비 중입니다." });
    return;
  }
  const parsed = cardSchema.safeParse(req.body);
  // 받은 몸통을 메시지나 로그에 싣지 않는다. 카드 정보다.
  if (!parsed.success) {
    res.status(400).json({ message: "카드 정보를 확인해 주세요." });
    return;
  }
  const accountId = req.partner!.sub;

  const existing = await prisma.subscription.findUnique({ where: { account_id: accountId } });
  if (existing?.auto_renew && existing.billing_key != null) {
    res.status(409).json({
      code: "already_subscribed",
      message: "이미 자동결제가 등록되어 있습니다. 카드를 바꾸려면 해지 후 다시 등록해 주세요.",
    });
    return;
  }
  const blocked = await whyNotSellable(accountId);
  if (blocked != null) {
    res.status(blocked.status).json(blocked.body);
    return;
  }

  const { agree: _agree, ...card } = parsed.data;
  let bid: string;
  try {
    ({ bid } = await registerBilling({ orderId: newOrderId("reg"), card }));
  } catch (e) {
    // 카드사가 준 말("유효기간 오류" 등)은 사람이 고칠 수 있는 말이라 그대로
    // 보여 준다. 코드만 로그에 남긴다 - 카드 정보는 없다.
    const code = e instanceof NiceError ? e.code : "unknown";
    console.error("[billing] 카드 등록 실패", accountId, code);
    res.status(400).json({
      code: "card_rejected",
      message: e instanceof NiceError ? e.message : "카드를 등록하지 못했습니다.",
    });
    return;
  }

  const amount = MONTHLY_AMOUNT;
  const orderId = newOrderId("sub");
  const row = await prisma.payment.create({
    data: { account_id: accountId, order_id: orderId, amount, months: 1, status: "pending" },
  });

  try {
    const r = await chargeBilling({ bid, orderId, amount, goodsName: `${GOODS_NAME} 월 자동결제` });
    await prisma.payment.update({
      where: { id: row.id },
      data: {
        tid: typeof r.tid === "string" ? r.tid : null,
        status: "paid",
        pay_method: "billing",
        paid_at: new Date(),
        raw: r as object,
        updated_at: new Date(),
      },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "결제에 실패했습니다.";
    console.error("[billing] 첫 청구 실패", accountId, orderId, e instanceof NiceError ? e.code : "");
    await prisma.payment.update({
      where: { id: row.id },
      data: { status: "failed", failed_reason: msg, updated_at: new Date() },
    });
    await expireBilling(bid, newOrderId("exp")).catch((err) =>
      console.error("[billing] 실패한 등록의 빌키를 지우지 못했다", accountId, err),
    );
    res.status(400).json({ code: "charge_failed", message: msg });
    return;
  }

  // 돈이 들어왔다. 기간과 광고는 단건 결제와 같은 함수로 민다.
  await extendSubscription(accountId, row.id, amount, 1);
  await prisma.subscription.update({
    where: { account_id: accountId },
    data: { billing_key: bid, auto_renew: true, failed_count: 0, updated_at: new Date() },
  });
  res.json({ ok: true });
});

/**
 * 자동결제를 끊는다.
 *
 * 광고를 바로 내리지 않는다 - 이번 주기까지는 돈을 받았다. 다음 청구만
 * 막고, 나이스에 맡긴 카드 연결(빌키)을 지운다.
 */
router.post("/billing/cancel", partnerRequired, async (req, res) => {
  const accountId = req.partner!.sub;
  const sub = await prisma.subscription.findUnique({ where: { account_id: accountId } });
  if (sub?.billing_key == null) {
    res.status(404).json({ message: "등록된 자동결제가 없습니다." });
    return;
  }
  // 나이스에서 지우지 못해도 우리 쪽은 끊는다. 우리가 청구하지 않으면
  // 돈은 빠지지 않는다. 지우지 못한 것은 로그로 남겨 사람이 정리한다.
  await expireBilling(sub.billing_key, newOrderId("exp")).catch((err) =>
    console.error("[billing] 해지 중 빌키를 지우지 못했다", accountId, err),
  );
  await prisma.subscription.update({
    where: { id: sub.id },
    data: { auto_renew: false, billing_key: null, canceled_at: new Date(), updated_at: new Date() },
  });
  res.json({ ok: true, currentPeriodEnd: sub.current_period_end.toISOString() });
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
 * 아직 없다.
 *
 * 나이스 V2 결제창에는 카드 등록(빌링키 발급)이 없다 - method 에 billing
 * 이라는 값 자체가 없어, 넣으면 결제창이 P012(파라미터 오류)를 낸다.
 * 빌링키를 받으려면 /v1/subscribe/regist 에 카드번호·생년월일·카드
 * 비밀번호를 암호화해 보내야 하고, 그러려면 그 값들을 우리가 받아야 한다.
 * 소아 의료 자료를 들고 있는 서버에 카드번호까지 얹을 일이 아니다.
 *
 * 그래서 지금은 기간이 끝나기 전에 메일로 알리고(scripts/notify-expiring-
 * promotions.ts) 파트너가 직접 연장한다.
 *
 * 인증형 빌키발급 상품을 계약하면 여기에 등록 경로만 붙이면 된다 -
 * 청구(chargeBilling), 기간 계산, 결제 기록, 광고 연장은 직접 결제와
 * 같은 것을 이미 쓰고 있다.
 */

export default router;
