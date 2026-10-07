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
import { NiceError, chargeBilling, expireBilling } from "./nicepay";
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
  const blocked = await whyNotSellable(s.account_id);
  if (blocked != null) {
    await onFailure(s, blocked.body.message, mail);
    return;
  }

  // 줄을 먼저 만든다. 같은 번호가 이미 있으면 다른 실행이 이 일을 하고
  // 있거나 끝낸 것이다.
  let paymentId: string;
  try {
    paymentId = (
      await prisma.payment.create({
        data: {
          account_id: s.account_id,
          subscription_id: s.id,
          order_id: orderId,
          amount: s.amount,
          months: 1,
          status: "pending",
          pay_method: "billing",
        },
      })
    ).id;
  } catch {
    console.log("[갱신] 이미 처리된 주문", orderId);
    return;
  }

  try {
    const r = await chargeBilling({
      bid: s.billing_key,
      orderId,
      amount: s.amount,
      goodsName: `${GOODS_NAME} 월 자동결제`,
    });
    await prisma.payment.update({
      where: { id: paymentId },
      data: {
        tid: typeof r.tid === "string" ? r.tid : null,
        status: "paid",
        paid_at: new Date(),
        raw: r as object,
        updated_at: new Date(),
      },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "결제에 실패했습니다.";
    console.error("[갱신] 청구 실패", s.account_id, orderId, e instanceof NiceError ? e.code : "");
    await prisma.payment.update({
      where: { id: paymentId },
      data: { status: "failed", failed_reason: msg, updated_at: new Date() },
    });
    await onFailure(s, msg, mail);
    return;
  }

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
