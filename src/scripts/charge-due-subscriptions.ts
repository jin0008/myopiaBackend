/**
 * 기간이 끝난 구독을 빌링키로 청구한다.
 *
 *   node dist/scripts/charge-due-subscriptions.js
 *
 * 하루에 한 번 돌린다(systemd timer). 나이스는 "매달 1일에 긁어라"를
 * 기억해 주지 않는다 - 빌링키로 카드번호를 대신 들어 줄 뿐, 언제 청구할지는
 * 우리가 센다.
 *
 * 두 가지 일을 한다.
 *   1. 끝나기 7일 전 안내 메일 (전자상거래법상 정기결제는 미리 알려야 한다)
 *   2. 기간이 끝난 구독 청구
 */
import "dotenv/config";

import prisma from "../lib/prisma";
import { sendEmail } from "../services/email";
import { chargeBilling, isConfigured } from "../services/nicepay";
import { extendSubscription } from "../services/subscription";

/** 카드가 막혔다고 바로 끊지 않는다. 고치고 돌아올 틈을 준다. */
const MAX_FAILS = 3;
const NOTICE_DAYS = 7;

/** 같은 달에 두 번 청구되지 않게 주문번호를 날짜로 고정한다. 재시도가
 *  이중 청구로 번지는 것은 order_id 의 unique 가 막는다. */
function orderIdFor(subId: string, end: Date): string {
  return `auto_${subId.slice(0, 8)}_${end.toISOString().slice(0, 10)}`;
}

function won(n: number): string {
  return n.toLocaleString("ko-KR") + "원";
}

async function notifyUpcoming(now: Date): Promise<void> {
  const until = new Date(now.getTime() + NOTICE_DAYS * 24 * 3600 * 1000);
  const rows = await prisma.subscription.findMany({
    where: {
      auto_renew: true,
      billing_key: { not: null },
      current_period_end: { gt: now, lte: until },
    },
    include: { account: { select: { email: true, hospital_name: true } } },
  });
  for (const s of rows) {
    // 같은 주기에 두 번 보내지 않는다. 매일 도는 일이라 안 막으면 7통이 간다.
    if (
      s.notified_for != null &&
      s.notified_for.getTime() === s.current_period_end.getTime()
    ) {
      continue;
    }
    const on = s.current_period_end.toISOString().slice(0, 10);
    await sendEmail(
      [s.account.email],
      "[마이오닥] 프리미엄 노출 자동 결제 예정 안내",
      `<p>${s.account.hospital_name} 님,</p>
       <p><b>${on}</b>에 등록하신 카드로 <b>${won(s.amount)}</b>이 결제될 예정입니다.</p>
       <p>자동 결제를 원하지 않으시면 그 전에 파트너 페이지 &gt; 프리미엄 노출에서
          해지하실 수 있습니다. 해지하셔도 이미 결제된 기간까지는 그대로 노출됩니다.</p>`,
    );
    await prisma.subscription.update({
      where: { id: s.id },
      data: { notified_for: s.current_period_end, updated_at: new Date() },
    });
    console.log(`[구독] 예정 안내 ${s.account.hospital_name} ${on}`);
  }
}

async function chargeDue(now: Date): Promise<void> {
  const due = await prisma.subscription.findMany({
    where: {
      auto_renew: true,
      billing_key: { not: null },
      current_period_end: { lte: now },
      failed_count: { lt: MAX_FAILS },
      // 한 번은 직접 결제한 적이 있어야 한다. 자동 갱신은 이미 산 것을
      // 잇는 일이다 - 카드만 등록해 둔 곳에서 빼면, 화면에 적어 둔
      // "등록만으로는 돈이 빠지지 않습니다"가 거짓말이 된다.
      payments: { some: { status: "paid" } },
    },
    include: { account: { select: { email: true, hospital_name: true } } },
  });

  for (const s of due) {
    const orderId = orderIdFor(s.id, s.current_period_end);
    // 재시도로 다시 들어온 건이면 이미 만든 주문이 있다. 성공한 것이면
    // 건드리지 않는다 - 결제는 됐는데 기간만 못 민 경우다.
    const existing = await prisma.payment.findUnique({ where: { order_id: orderId } });
    if (existing?.status === "paid") {
      console.log(`[구독] 이미 결제됨 ${s.account.hospital_name} ${orderId}`);
      continue;
    }

    const row =
      existing ??
      (await prisma.payment.create({
        data: {
          account_id: s.account_id,
          subscription_id: s.id,
          order_id: orderId,
          amount: s.amount,
          months: 1,
          status: "pending",
        },
      }));

    try {
      const r = await chargeBilling({
        bid: s.billing_key!,
        orderId,
        amount: s.amount,
        goodsName: "마이오닥 프리미엄 1개월",
      });
      await prisma.payment.update({
        where: { id: row.id },
        data: {
          tid: typeof r.tid === "string" ? r.tid : null,
          status: "paid",
          pay_method: typeof r.payMethod === "string" ? r.payMethod : null,
          paid_at: new Date(),
          failed_reason: null,
          raw: r as object,
          updated_at: new Date(),
        },
      });
      await prisma.subscription.update({
        where: { id: s.id },
        data: { status: "active", failed_count: 0, updated_at: new Date() },
      });
      // 기간을 밀고 광고도 함께 연장한다. 직접 결제한 길과 같은 함수다.
      await extendSubscription(s.account_id, row.id, s.amount, 1);
      console.log(`[구독] 청구 성공 ${s.account.hospital_name} ${won(s.amount)}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "청구에 실패했습니다.";
      const fails = s.failed_count + 1;
      await prisma.payment.update({
        where: { id: row.id },
        data: { status: "failed", failed_reason: msg, updated_at: new Date() },
      });
      // past_due 는 청구가 실패했지만 아직 끊지 않은 상태다. 카드가 한 번
      // 막혔다고 바로 광고를 내리면, 고치고 돌아와도 그달이 날아간다.
      await prisma.subscription.update({
        where: { id: s.id },
        data: {
          status: "past_due",
          failed_count: fails,
          auto_renew: fails < MAX_FAILS,
          updated_at: new Date(),
        },
      });
      console.error(`[구독] 청구 실패 ${s.account.hospital_name} (${fails}/${MAX_FAILS}) ${msg}`);
      await sendEmail(
        [s.account.email],
        fails < MAX_FAILS
          ? "[마이오닥] 자동 결제가 되지 않았습니다"
          : "[마이오닥] 자동 결제를 중단했습니다",
        fails < MAX_FAILS
          ? `<p>${s.account.hospital_name} 님, 등록하신 카드로 결제가 되지 않았습니다. (${msg})</p>
             <p>내일 다시 시도합니다. 카드를 바꾸시려면 파트너 페이지에서 다시 등록해 주세요.</p>`
          : `<p>${s.account.hospital_name} 님, ${MAX_FAILS}번 모두 결제되지 않아 자동 결제를 중단했습니다. (${msg})</p>
             <p>계속 이용하시려면 파트너 페이지에서 카드를 다시 등록해 주세요.
                이미 결제된 기간까지는 그대로 노출됩니다.</p>`,
      );
    }
  }
}

async function main() {
  if (!isConfigured()) {
    console.error("[구독] 결제 설정이 없다. 아무것도 하지 않는다.");
    return;
  }
  const now = new Date();
  await notifyUpcoming(now);
  await chargeDue(now);
}

main()
  .catch((err) => {
    console.error("[구독] 실패", err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
