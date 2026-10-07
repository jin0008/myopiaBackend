/**
 * 자동결제 갱신의 판단.
 *
 *   npx tsx scripts/check-billing-renewal.ts
 *
 * 돈이 걸린 자리다. 틀리면 두 번 빠지거나, 빠져야 할 달에 안 빠진다.
 */
import assert from "assert";

import {
  MAX_RENEW_FAILS,
  isRenewalDue,
  outcomeFromLookup,
  renewalOrderId,
  shouldStopAfter,
} from "../src/services/billing";

const now = new Date("2026-11-06T18:00:00Z"); // KST 11/7 03:00, 매일 도는 시각쯤
const h = 3600 * 1000;

assert.ok(isRenewalDue(new Date(now.getTime() + 20 * h), now), "끝나기 하루 안쪽이면 청구");
assert.ok(isRenewalDue(new Date(now.getTime() - 48 * h), now), "이미 끝났으면(연체) 청구");
assert.ok(!isRenewalDue(new Date(now.getTime() + 30 * h), now), "하루 넘게 남았으면 아직");
// 매일 한 번 돌 때 끝나기 전에 반드시 한 번은 걸린다: 24~48시간 남은 날은
// 건너뛰고 그다음 날(0~24시간 남음) 청구한다.
assert.ok(isRenewalDue(new Date(now.getTime() + 24 * h), now), "경계(정확히 하루)도 청구");

const sub = "3f2a9c10-aaaa-bbbb-cccc-000000000000";
const end = new Date("2026-11-07T00:00:00+09:00");
assert.strictEqual(renewalOrderId(sub, end, 0), renewalOrderId(sub, end, 0), "같은 주기·시도는 같은 번호 - 겹쳐 돌아도 한 번만");
assert.notStrictEqual(renewalOrderId(sub, end, 0), renewalOrderId(sub, end, 1), "실패 뒤 다시 할 때는 새 번호");
assert.notStrictEqual(
  renewalOrderId(sub, end, 0),
  renewalOrderId(sub, new Date("2026-12-07T00:00:00+09:00"), 0),
  "다음 달은 새 번호",
);
assert.strictEqual(renewalOrderId(sub, end, 0), "ren_3f2a9c10_20261107_0", "날짜는 KST");
assert.ok(renewalOrderId(sub, end, 9).length <= 64, "나이스 orderId 64자 제한");

assert.ok(!shouldStopAfter(1) && !shouldStopAfter(MAX_RENEW_FAILS - 1), "한두 번 실패로는 끊지 않는다");
assert.ok(shouldStopAfter(MAX_RENEW_FAILS), `${MAX_RENEW_FAILS}번 연속이면 끊는다`);

// 응답이 끊긴 청구를 주문번호로 확정할 때.
const paid = { resultCode: "0000", resultMsg: "", status: "paid", amount: 100000 };
assert.strictEqual(outcomeFromLookup(paid, 100000, "unknown").outcome, "paid", "실제로 빠졌으면 성공 - 다시 청구하지 않는다");
assert.strictEqual(outcomeFromLookup({ ...paid, amount: 100 }, 100000, "unknown").outcome, "failed", "금액이 다르면 성공 아님");
assert.strictEqual(
  outcomeFromLookup({ resultCode: "0000", resultMsg: "한도초과", status: "failed" }, 100000, "unknown").outcome,
  "failed",
);
const missing = { resultCode: "2001", resultMsg: "거래 없음" };
assert.strictEqual(outcomeFromLookup(missing, 100000, "unknown").outcome, "unknown", "끊긴 직후 안 보이면 모른다 - 실패로 세지 않는다");
assert.strictEqual(outcomeFromLookup(missing, 100000, "failed").outcome, "failed", "하루 지나도 없으면 실패");

console.log("billing renewal ok");
