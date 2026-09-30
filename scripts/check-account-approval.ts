/**
 * 안경원 승인 조건이 맞는지 본다.
 *
 *   npx tsx scripts/check-account-approval.ts
 *
 * 막아야 할 것을 안 막으면 파트너가 승인 메일을 받고 들어와 프리미엄
 * 화면에서 막힌다. 반대로 과하게 막으면 병원 승인이 통째로 멈춘다.
 */
import assert from "assert";

/** partner.ts 의 판단과 같은 식. 여기만 고치면 저쪽과 어긋나므로 같이 고친다. */
function blocked(
  status: "approved" | "rejected" | "pending",
  businessKind: string,
  facilityKey: string | null,
): boolean {
  return status === "approved" && businessKind === "optical" && facilityKey == null;
}

// 막아야 하는 단 하나의 경우
assert.ok(blocked("approved", "optical", null), "연결 없는 안경원 승인은 막아야 한다");

// 나머지는 전부 통과해야 한다
assert.ok(!blocked("approved", "optical", "PHMB220013010033082200015"), "연결된 안경원");
assert.ok(!blocked("approved", "hospital", null), "병원은 연결 없이도 승인된다(프로필 노출)");
assert.ok(!blocked("pending", "optical", null), "되돌리는 것은 막지 않는다");
assert.ok(!blocked("rejected", "optical", null), "거절은 막지 않는다 - 막으면 정리할 길이 없다");

console.log("ok — 연결 없는 안경원 승인만 막고, 병원 승인과 되돌리기는 건드리지 않는다");
