/**
 * 정기결제(빌링).
 *
 * 카드 등록과 첫 달 청구는 결제 라우트(routes/payment.ts)가 한다. 여기는
 * 둘이 같이 쓰는 판정과, 매일 도는 작업이 부르는 갱신(매달 청구)이다.
 */

import prisma from "../lib/prisma";
import { AD_SLOTS } from "../lib/adSlots";
import { GOODS_NAME } from "../lib/pricing";
import { kstDateString } from "../lib/promotionTerm";
import { NiceError, type NiceResult, chargeBilling, expireBilling, findPayment } from "./nicepay";
import { RegionUnknown, adsInRegion, linkedFacility, regionOf } from "./promotionSlots";
import { extendSubscription } from "./subscription";

/**
 * 이 계정에 지금 팔 수 있나. 막히면 화면에 보낼 상태와 몸통을, 아니면 null.
 *
 * 단건 결제(checkout)와 카드 등록(billing)이 같은 문을 지난다. 두 벌로
 * 두면 한쪽만 고쳐져 "결제창으로는 막히는데 자동결제로는 같은 동에 둘이
 * 걸리는" 구멍이 생긴다.
 */
export async function whyNotSellable(
  accountId: string,
): Promise<{ status: number; body: Record<string, string> } | null> {
  // 업체가 묶이지 않은 계정은 광고를 걸 곳이 없다. 돈부터 받고 나서
  // "그런데 어느 가게죠"를 물으면 안 된다.
  const account = await prisma.hospital_account.findUnique({
    where: { id: accountId },
    select: { facility_key: true },
  });
  const me = account?.facility_key == null ? null : await linkedFacility(accountId);
  if (me == null) {
    return {
      status: 403,
      body: { code: "facility_not_linked", message: "업체 인증을 먼저 마쳐 주세요." },
    };
  }
  // 같은 행정동에 이미 광고가 있으면 팔지 않는다. 동 하나에 한 곳이 이
  // 상품의 전부고, 돈을 받고 나서 거절하면 환불을 해야 하는 데다 그 사이
  // "독점을 샀는데 옆집도 뜬다"는 말을 듣는다. 막는 자리는 결제 전이다.
  try {
    const region = await regionOf(me.lat, me.lng);
    const taken = await adsInRegion(me.kind, region.code, me.key);
    if (taken.length >= AD_SLOTS) {
      return {
        status: 409,
        body: {
          code: "region_taken",
          message: `${region.name}에 이미 노출 중인 곳이 있어 신청할 수 없습니다.`,
        },
      };
    }
  } catch (e) {
    // 동을 모르면 팔지 않는다. 모르는 채로 팔면 같은 동에 둘이 걸린다.
    if (e instanceof RegionUnknown) {
      return {
        status: 503,
        body: {
          code: "region_unknown",
          message: "지금은 신청을 처리할 수 없습니다. 잠시 후 다시 시도해 주세요.",
        },
      };
    }
    throw e;
  }
  return null;
}

/** 주문번호. 같은 번호로 두 번 청구되지 않는다(payment.order_id unique). */
export function newOrderId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** 청구 결과. 'unknown' 은 돈이 빠졌는지 모르는 상태다 - 실패로 다루면 안 된다. */
export type ChargeOutcome =
  | { outcome: "paid"; r: NiceResult }
  | { outcome: "failed"; message: string }
  | { outcome: "unknown" };

/**
 * 나이스가 결과를 말해 준 오류인가.
 *
 * resultCode 를 받아 던진 NiceError 는 "나이스가 거절했다"는 확실한 답이다.
 * 시간 초과·연결 끊김(fetch 가 던짐)과 응답을 못 읽은 bad_response 는
 * 나이스 쪽에서 승인됐을 수도 있는 상태다.
 */
function isDefiniteRejection(e: unknown): boolean {
  return e instanceof NiceError && e.code !== "bad_response";
}

/**
 * 주문번호로 결과를 확정한다.
 *
 * notFoundMeans: 나이스에 그 주문이 없을 때 어떻게 볼지. 끊긴 직후에는
 * 아직 안 보일 수 있어 'unknown', 하루 지난 뒤라면 'failed' 로 본다.
 */
export async function resolveByOrderId(
  orderId: string,
  createdAt: Date,
  amount: number,
  notFoundMeans: "unknown" | "failed",
): Promise<ChargeOutcome> {
  let f: NiceResult;
  try {
    f = await findPayment(orderId, kstDateString(createdAt).replace(/-/g, ""));
  } catch {
    return { outcome: "unknown" };
  }
  return outcomeFromLookup(f, amount, notFoundMeans);
}

/** 조회 응답을 결과로. 네트워크 없이 맞춰 볼 수 있게 따로 둔다. */
export function outcomeFromLookup(
  f: NiceResult,
  amount: number,
  notFoundMeans: "unknown" | "failed",
): ChargeOutcome {
  if (f.resultCode === "0000" && f.status === "paid") {
    // 금액이 다르면 성공으로 보지 않는다(check-payment.ts 와 같은 규칙).
    return f.amount === amount
      ? { outcome: "paid", r: f }
      : { outcome: "failed", message: "결제 금액이 주문과 다릅니다." };
  }
  if (f.resultCode === "0000" && (f.status === "failed" || f.status === "expired")) {
    return { outcome: "failed", message: f.resultMsg || "결제에 실패했습니다." };
  }
  // 'ready' 같은 진행 중 상태나 '주문 없음'. 시간이 지났으면 실패로 본다.
  return notFoundMeans === "failed"
    ? { outcome: "failed", message: f.resultMsg || "결제가 확인되지 않았습니다." }
    : { outcome: "unknown" };
}

/** 빌키로 청구한다. 응답이 끊기면 주문번호로 다시 물어 확정한다. */
export async function chargeSafely(args: {
  bid: string;
  orderId: string;
  amount: number;
  goodsName: string;
  createdAt: Date;
}): Promise<ChargeOutcome> {
  try {
    return { outcome: "paid", r: await chargeBilling(args) };
  } catch (e) {
    if (isDefiniteRejection(e)) return { outcome: "failed", message: (e as Error).message };
    console.error("[billing] 청구 응답이 끊겼다. 주문번호로 확인한다", args.orderId);
    return resolveByOrderId(args.orderId, args.createdAt, args.amount, "unknown");
  }
}

/**
 * 대기 중인 결제를 '결제됨'으로 바꾼다. 한 번만 성공한다.
 *
 * 같은 결제를 확정하는 길이 여럿이다(청구 응답, 웹훅, 갱신의 재확인, 첫
 * 결제 정리). 각자 읽고 나서 쓰면 둘이 함께 '아직 대기'를 보고 둘 다 기간을
 * 늘린다 - 한 번 낸 돈으로 두 달. 상태가 pending 인 줄만 바꾸고, 바꾼 쪽만
 * true 를 받아 기간을 늘린다.
 */
export async function markPaidOnce(
  paymentId: string,
  r: NiceResult,
): Promise<boolean> {
  const done = await prisma.payment.updateMany({
    where: { id: paymentId, status: "pending" },
    data: {
      tid: typeof r.tid === "string" ? r.tid : null,
      status: "paid",
      paid_at: new Date(),
      failed_reason: null,
      raw: r as object,
      updated_at: new Date(),
    },
  });
  return done.count === 1;
}

/** 대기 중인 결제를 실패로. 바꾼 쪽만 true - 실패 처리(횟수·메일)를 한 번만 한다. */
export async function markFailedOnce(paymentId: string, reason: string): Promise<boolean> {
  const done = await prisma.payment.updateMany({
    where: { id: paymentId, status: "pending" },
    data: { status: "failed", failed_reason: reason, updated_at: new Date() },
  });
  return done.count === 1;
}

/** 하루. 갱신은 끝나기 하루 안쪽에 들어오면 청구한다. */
const DAY = 24 * 3600 * 1000;

/**
 * 몇 번 연속 실패하면 자동결제를 끊나.
 *
 * 한 번 막혔다고 바로 끊지 않는다 - 한도 초과나 카드 교체처럼 하루 이틀이면
 * 풀리는 일이 많다. 그 사이 광고는 이미 결제한 기간이 끝나는 날 저절로
 * 멈춘다(facility_promotion.ends_at). 다시 결제되면 그날부터 다시 건다.
 */
export const MAX_RENEW_FAILS = 3;

/** 이 구독을 지금 청구할 때인가. 매일 한 번 돌므로 끝나기 하루 안쪽이면 한다. */
export function isRenewalDue(periodEnd: Date, now: Date): boolean {
  return periodEnd.getTime() - now.getTime() <= DAY;
}

/**
 * 갱신 주문번호. 같은 주기·같은 시도에는 같은 번호가 나온다.
 *
 * 매일 도는 작업이 두 번 겹쳐 돌아도 두 번 빠지지 않게 하는 열쇠다 -
 * payment.order_id 가 유니크라 두 번째는 줄을 만들지 못하고, 나이스도 같은
 * 번호를 거절한다. 실패한 뒤 다시 할 때는 시도 횟수가 달라 새 번호가 된다.
 */
export function renewalOrderId(subId: string, periodEnd: Date, attempt: number): string {
  return `ren_${subId.slice(0, 8)}_${kstDateString(periodEnd).replace(/-/g, "")}_${attempt}`;
}

/** 실패 뒤의 처리. 끊을 때면 true. */
export function shouldStopAfter(failedCount: number): boolean {
  return failedCount >= MAX_RENEW_FAILS;
}

type Mailer = (to: string, subject: string, html: string) => Promise<void>;

/**
 * 끝나 가는 자동결제 구독을 청구한다. 매일 한 번 부른다.
 *
 * 돈이 걸린 일이라 한 곳이 터져도 다음 업체로 넘어간다. 각 업체의 결과는
 * payment 와 subscription 에 남는다.
 */
export async function renewDueSubscriptions(now: Date, mail: Mailer): Promise<void> {
  const rows = await prisma.subscription.findMany({
    where: {
      auto_renew: true,
      billing_key: { not: null },
      current_period_end: { lte: new Date(now.getTime() + DAY) },
    },
    include: { account: { select: { email: true, hospital_name: true } } },
  });

  for (const s of rows) {
    try {
      await renewOne(s, mail);
    } catch (err) {
      console.error("[갱신] 처리 중 오류", s.account_id, err);
    }
  }
}

async function renewOne(
  s: {
    id: string;
    account_id: string;
    billing_key: string | null;
    current_period_end: Date;
    amount: number;
    failed_count: number;
    account: { email: string; hospital_name: string };
  },
  mail: Mailer,
): Promise<void> {
  if (s.billing_key == null) return;
  const orderId = renewalOrderId(s.id, s.current_period_end, s.failed_count);

  // 팔 수 없는 상태면 청구하지 않는다. 연체 중 기간이 끝나 동이 풀리고 그
  // 사이 다른 업체가 샀을 수 있다 - 돈을 받고 광고를 못 거는 일이 생긴다.
  //
  // 다만 동을 잠깐 못 알아낸 것(카카오 장애)은 카드 탓이 아니다. 실패로
  // 세면 장애 사흘에 자동결제가 끊기고 "카드를 확인하라"는 메일이 간다.
  // 그날은 건너뛰고 다음 날 다시 한다.
  const blocked = await whyNotSellable(s.account_id);
  if (blocked?.body.code === "region_unknown") {
    console.warn("[갱신] 동을 알아내지 못해 오늘은 건너뛴다", s.account_id);
    return;
  }
  if (blocked != null) {
    await onFailure(s, blocked.body.message, mail);
    return;
  }

  // 같은 주문번호의 줄이 이미 있으면 지난 실행이 끝을 못 본 것이다(응답이
  // 끊겼거나 겹쳐 돌았다). 새로 청구하지 않고 그 주문의 결과를 확정한다 -
  // 새로 청구하면 같은 달이 두 번 빠질 수 있다.
  const prior = await prisma.payment.findUnique({ where: { order_id: orderId } });
  let paymentId: string;
  let outcome: ChargeOutcome;
  if (prior != null) {
    if (prior.status === "paid") return;
    paymentId = prior.id;
    outcome =
      prior.status === "failed"
        ? { outcome: "failed", message: prior.failed_reason ?? "결제에 실패했습니다." }
        : await resolveByOrderId(
            orderId,
            prior.created_at,
            prior.amount,
            // 막 만든 줄이면 다른 실행이 아직 청구 중일 수 있다. 하루가 지나도
            // 나이스에 없을 때만 실패로 본다.
            Date.now() - prior.created_at.getTime() > DAY ? "failed" : "unknown",
          );
  } else {
    let row;
    try {
      row = await prisma.payment.create({
        data: {
          account_id: s.account_id,
          subscription_id: s.id,
          order_id: orderId,
          amount: s.amount,
          months: 1,
          status: "pending",
          pay_method: "billing",
        },
      });
    } catch {
      // 바로 앞에서 다른 실행이 만들었다. 그쪽이 끝낸다.
      console.log("[갱신] 다른 실행이 처리 중인 주문", orderId);
      return;
    }
    paymentId = row.id;
    outcome = await chargeSafely({
      bid: s.billing_key,
      orderId,
      amount: s.amount,
      goodsName: `${GOODS_NAME} 월 자동결제`,
      createdAt: row.created_at,
    });
  }

  if (outcome.outcome === "unknown") {
    // 돈이 빠졌는지 모른다. 실패로 세지도, 다시 청구하지도 않는다. 줄을
    // pending 으로 두면 내일 위의 prior 경로가 결과를 확정한다.
    console.error("[갱신] 결과를 모르는 청구 - 내일 다시 확인한다", s.account_id, orderId);
    return;
  }
  if (outcome.outcome === "failed") {
    console.error("[갱신] 청구 실패", s.account_id, orderId);
    // 이미 실패로 적힌 줄(지난 실행이 실패 처리 도중 멈춘 경우)도 처리한다.
    // 그러지 않으면 같은 주문번호에 묶여 다음 날도, 그다음 날도 넘어간다.
    const claimed = await markFailedOnce(paymentId, outcome.message);
    if (claimed || prior?.status === "failed") await onFailure(s, outcome.message, mail);
    return;
  }
  // 웹훅이 먼저 확정했으면 그쪽이 기간을 늘렸다. 여기서 또 늘리지 않는다.
  if (!(await markPaidOnce(paymentId, outcome.r))) return;

  // 단건 결제와 같은 함수로 기간과 광고를 민다.
  await extendSubscription(s.account_id, paymentId, s.amount, 1);
  await prisma.subscription.update({
    where: { id: s.id },
    data: { failed_count: 0, status: "active", updated_at: new Date() },
  });
  console.log(`[갱신] ${s.account.hospital_name} ${s.amount}원 결제`);
}

async function onFailure(
  s: { id: string; account_id: string; billing_key: string | null; failed_count: number; account: { email: string; hospital_name: string } },
  reason: string,
  mail: Mailer,
): Promise<void> {
  const failed = s.failed_count + 1;
  const stop = shouldStopAfter(failed);
  if (stop && s.billing_key != null) {
    await expireBilling(s.billing_key, newOrderId("exp")).catch((err) =>
      console.error("[갱신] 끊으면서 빌키를 지우지 못했다", s.account_id, err),
    );
  }
  await prisma.subscription.update({
    where: { id: s.id },
    data: stop
      ? {
          failed_count: failed,
          status: "canceled",
          auto_renew: false,
          billing_key: null,
          canceled_at: new Date(),
          updated_at: new Date(),
        }
      : { failed_count: failed, status: "past_due", updated_at: new Date() },
  });

  const name = s.account.hospital_name;
  await mail(
    s.account.email,
    stop ? "[마이오닥] 자동결제가 중지되었습니다" : "[마이오닥] 자동결제에 실패했습니다",
    stop
      ? `<p>${name} 님, 안녕하세요.</p>
         <p>등록하신 카드로 ${MAX_RENEW_FAILS}번 연속 결제하지 못해 자동결제를 중지했습니다.</p>
         <p>사유: ${reason}</p>
         <p>이미 결제하신 기간이 끝나면 프리미엄 노출이 멈춥니다. 계속 이용하시려면
            파트너 페이지에서 카드를 다시 등록하거나 결제해 주세요.</p>`
      : `<p>${name} 님, 안녕하세요.</p>
         <p>등록하신 카드로 이번 달 결제를 하지 못했습니다.</p>
         <p>사유: ${reason}</p>
         <p>내일 다시 시도합니다. 카드 한도나 상태를 확인해 주세요. ${MAX_RENEW_FAILS}번
            연속 실패하면 자동결제가 중지되고, 결제가 될 때까지 프리미엄 노출이 멈춥니다.</p>`,
  ).catch((err) => console.error("[갱신] 실패 안내 메일을 보내지 못했다", s.account.email, err));
}

/**
 * 결과를 모르는 첫 결제(bil_)를 확정한다. 매일 한 번 부른다.
 *
 * 카드 등록 직후 청구 응답이 끊기면 줄은 pending 으로, 빌키는 구독에
 * (auto_renew 를 끈 채) 남는다. 그동안 그 계정은 새로 등록하지 못하므로
 * 여기서 풀어 줘야 한다. 막 만든 줄은 웹훅을 기다리고, 하루가 지나도
 * 나이스에 없으면 실패로 본다.
 */
export async function settleFirstCharges(now: Date): Promise<void> {
  const rows = await prisma.payment.findMany({
    where: {
      status: "pending",
      order_id: { startsWith: "bil_" },
      created_at: { lt: new Date(now.getTime() - 10 * 60 * 1000) },
    },
  });
  for (const p of rows) {
    try {
      const outcome = await resolveByOrderId(
        p.order_id,
        p.created_at,
        p.amount,
        now.getTime() - p.created_at.getTime() > DAY ? "failed" : "unknown",
      );
      if (outcome.outcome === "unknown") continue;
      const sub = await prisma.subscription.findUnique({ where: { account_id: p.account_id } });
      if (outcome.outcome === "paid") {
        if (await markPaidOnce(p.id, outcome.r)) {
          await extendSubscription(p.account_id, p.id, p.amount, 1);
        }
        if (sub?.billing_key != null) {
          await prisma.subscription.update({
            where: { id: sub.id },
            data: { auto_renew: true, failed_count: 0, updated_at: new Date() },
          });
        }
        console.log("[첫 결제] 결과를 확정했다: 결제됨", p.account_id, p.order_id);
        continue;
      }
      if (await markFailedOnce(p.id, outcome.message)) {
        // 켜지지 않은 채 남은 빌키를 지운다. 켜진 것(다른 카드로 이미 등록)은 둔다.
        if (sub?.billing_key != null && !sub.auto_renew) {
          await expireBilling(sub.billing_key, newOrderId("exp")).catch((err) =>
            console.error("[첫 결제] 빌키를 지우지 못했다", p.account_id, err),
          );
          await prisma.subscription.update({
            where: { id: sub.id },
            data: { billing_key: null, updated_at: new Date() },
          });
        }
        console.log("[첫 결제] 결과를 확정했다: 실패", p.account_id, p.order_id);
      }
    } catch (err) {
      console.error("[첫 결제] 확정 중 오류", p.account_id, p.order_id, err);
    }
  }
}
