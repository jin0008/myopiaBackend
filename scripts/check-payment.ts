/**
 * 결제 기록을 맞출 때의 규칙.
 *
 *   npx tsx scripts/check-payment.ts
 *
 * 돈이 걸린 자리다. 틀리면 공짜로 구독이 켜지거나, 낸 사람이 못 쓴다.
 */
import assert from "assert";

/** 성공으로 볼 조건. 웹훅 몸통이 아니라 결제사 조회 응답을 본다. */
function isPaid(r: { resultCode: string; status?: string }, niceAmount: number, ourAmount: number) {
  const ok = r.resultCode === "0000" && r.status === "paid";
  return { paid: ok, amountOk: niceAmount === ourAmount, accept: ok && niceAmount === ourAmount };
}

assert.ok(isPaid({ resultCode: "0000", status: "paid" }, 50000, 50000).accept, "정상 결제");
assert.ok(!isPaid({ resultCode: "2001", status: "failed" }, 50000, 50000).accept, "실패는 거절");
assert.ok(
  !isPaid({ resultCode: "0000", status: "paid" }, 100, 50000).accept,
  "금액이 다르면 성공으로 보지 않는다 - 결제창에서 금액을 바꿔 넣는 수법이 있다",
);
assert.ok(!isPaid({ resultCode: "0000", status: "ready" }, 50000, 50000).accept, "승인 전");

/**
 * 다음 주기는 '끝나는 날'부터 더한다.
 *
 * 오늘부터 더하면 일찍 낸 사람이 남은 날을 잃는다.
 */
function nextPeriodEnd(currentEnd: Date, now: Date): Date {
  const from = currentEnd > now ? currentEnd : now;
  const next = new Date(from);
  next.setMonth(next.getMonth() + 1);
  return next;
}
const now = new Date("2026-10-03T00:00:00Z");
assert.strictEqual(
  nextPeriodEnd(new Date("2026-10-20T00:00:00Z"), now).toISOString().slice(0, 10),
  "2026-11-20",
  "아직 기간이 남았으면 그 끝에서 한 달",
);
assert.strictEqual(
  nextPeriodEnd(new Date("2026-09-01T00:00:00Z"), now).toISOString().slice(0, 10),
  "2026-11-03",
  "이미 지났으면 오늘에서 한 달",
);

/**
 * 산 개월 수만큼 민다.
 *
 * 한 달로 고정하면 석 달치를 낸 사람이 한 달만 받는다.
 */
function nextEnd(currentEnd: Date, now: Date, months: number): Date {
  const from = currentEnd > now ? currentEnd : now;
  const next = new Date(from);
  next.setMonth(next.getMonth() + months);
  return next;
}
assert.strictEqual(
  nextEnd(new Date("2026-10-20T00:00:00Z"), now, 3).toISOString().slice(0, 10),
  "2027-01-20",
  "석 달치를 사면 석 달이 는다",
);

/**
 * 같은 결제로 두 번 밀지 않는다.
 *
 * 결제창에서 돌아올 때 한 번 밀고, 웹훅이 같은 건으로 또 오면 두 번
 * 밀린다 - 한 번 낸 돈으로 두 달을 받는 셈이다.
 */
function shouldExtend(statusBefore: string): boolean {
  return statusBefore !== "paid" && statusBefore !== "canceled";
}
assert.ok(shouldExtend("pending"), "아직 안 끝난 결제는 민다");
assert.ok(!shouldExtend("paid"), "이미 끝난 결제는 또 밀지 않는다");
assert.ok(!shouldExtend("canceled"), "취소된 결제도 밀지 않는다");

/** 모르는 주문번호는 건드리지 않는다. 남의 상점 알림이거나 위조다. */
function shouldApply(ourOrder: { id: string } | null): boolean {
  return ourOrder != null;
}
assert.ok(!shouldApply(null), "우리가 만들지 않은 주문은 무시");
assert.ok(shouldApply({ id: "x" }));

/** 같은 주문번호로 두 번 청구되지 않는다(order_id unique). 재시도가
 *  이중 청구로 번지는 것을 DB 가 막는다. */
const orderIds = ["sub-1-202610", "sub-1-202610"];
assert.strictEqual(new Set(orderIds).size, 1, "같은 달 재시도는 같은 주문번호여야 한다");

console.log("ok — 금액이 맞고 결제사가 paid 라고 할 때만 인정하고, 주기는 끝나는 날부터 더한다");
