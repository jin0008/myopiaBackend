/**
 * 자동 갱신 규칙.
 *
 *   npx tsx scripts/check-subscription.ts
 *
 * 돈이 자동으로 빠지는 자리다. 틀리면 두 번 빠지거나, 끊은 사람에게서
 * 빠지거나, 내는 사람에게 안 빠진다.
 */
import assert from "assert";

const MAX_FAILS = 3;

/** 같은 주기에는 같은 주문번호다. 재시도가 이중 청구로 번지지 않는다
 *  - 나이스가 같은 주문번호를 거절하고, 우리 쪽은 order_id unique 가 막는다. */
function orderIdFor(subId: string, end: Date): string {
  return `auto_${subId.slice(0, 8)}_${end.toISOString().slice(0, 10)}`;
}
const sub = "0191f0aa-1111-2222-3333-444455556666";
const end = new Date("2026-11-03T14:59:59Z");
assert.strictEqual(
  orderIdFor(sub, end),
  orderIdFor(sub, end),
  "같은 주기 재시도는 같은 주문번호",
);
assert.notStrictEqual(
  orderIdFor(sub, end),
  orderIdFor(sub, new Date("2026-12-03T14:59:59Z")),
  "다음 주기는 다른 주문번호",
);

/**
 * 청구 대상.
 *
 * 카드만 있고 스위치가 꺼진 곳에서 빼면 안 된다 - 카드 등록과 "매달 빼
 * 가도 된다"는 다른 허락이다.
 */
function isDue(
  s: { autoRenew: boolean; billingKey: string | null; end: Date; fails: number },
  now: Date,
): boolean {
  return (
    s.autoRenew && s.billingKey != null && s.end <= now && s.fails < MAX_FAILS
  );
}
const now = new Date("2026-11-04T00:00:00Z");
const base = { autoRenew: true, billingKey: "bid", end, fails: 0 };
assert.ok(isDue(base, now), "기간이 끝났으면 청구한다");
assert.ok(!isDue({ ...base, autoRenew: false }, now), "해지한 곳에서는 빼지 않는다");
assert.ok(!isDue({ ...base, billingKey: null }, now), "카드가 없으면 못 뺀다");
assert.ok(
  !isDue({ ...base, end: new Date("2026-12-01T00:00:00Z") }, now),
  "아직 기간이 남았으면 안 뺀다",
);
assert.ok(!isDue({ ...base, fails: MAX_FAILS }, now), "세 번 막혔으면 그만둔다");

/**
 * 실패해도 바로 끊지 않는다.
 *
 * 카드가 한 번 막혔다고 광고를 내리면, 고치고 돌아와도 그달이 날아간다.
 */
function afterFail(fails: number): { fails: number; autoRenew: boolean } {
  const next = fails + 1;
  return { fails: next, autoRenew: next < MAX_FAILS };
}
assert.deepStrictEqual(afterFail(0), { fails: 1, autoRenew: true }, "한 번은 다시 해 본다");
assert.deepStrictEqual(afterFail(2), { fails: 3, autoRenew: false }, "세 번째에 멈춘다");

/** 예정 안내는 주기마다 한 번이다. 매일 도는 일이라 안 막으면 7통이 간다. */
function shouldNotify(notifiedFor: Date | null, end: Date): boolean {
  return notifiedFor == null || notifiedFor.getTime() !== end.getTime();
}
assert.ok(shouldNotify(null, end), "아직 안 보냈으면 보낸다");
assert.ok(!shouldNotify(end, end), "같은 주기에 또 보내지 않는다");
assert.ok(shouldNotify(end, new Date("2026-12-03T14:59:59Z")), "다음 주기에는 다시 보낸다");

console.log("ok — 같은 주기엔 한 번만 청구하고, 해지한 곳에서는 빼지 않는다");

/**
 * 카드만 등록해 둔 곳에서는 빼지 않는다.
 *
 * 자동 갱신은 이미 산 것을 잇는 일이다. 등록만 한 사람에게서 빼면 화면에
 * 적어 둔 "등록만으로는 돈이 빠지지 않습니다"가 거짓말이 된다.
 */
function isDue2(
  s: { autoRenew: boolean; billingKey: string | null; end: Date; fails: number; everPaid: boolean },
  at: Date,
): boolean {
  return isDue(s, at) && s.everPaid;
}
assert.ok(isDue2({ ...base, everPaid: true }, now), "산 적 있으면 잇는다");
assert.ok(!isDue2({ ...base, everPaid: false }, now), "카드만 등록한 곳에서는 빼지 않는다");

console.log("ok — 자동 갱신은 이미 산 것만 잇는다");
