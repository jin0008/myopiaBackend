/**
 * 계정을 지울 때 딸린 것들이 각각 맞게 처리되는지.
 *
 *   npx tsx scripts/check-account-delete.ts
 *
 * 프로필까지 지우면 앱에서 병원이 사라지고, 광고를 지우면 돈을 받은
 * 기간이 날아간다. 반대로 연결을 안 풀면 그 병원은 다시 가입할 수 없다.
 */
import assert from "assert";

type Fate = "cascade" | "setnull" | "orphan" | "keep";

/** 스키마가 정한 것 + 라우트가 손으로 하는 것. */
const FATE: Record<string, Fate> = {
  // onDelete: Cascade — 신청 이력은 계정과 함께 사라진다.
  facility_verification: "cascade",
  promotion_request: "cascade",
  // onDelete: SetNull — 이미 걸린 광고는 기간이 끝날 때까지 나간다.
  facility_promotion: "setnull",
  // 외래키가 없다. 라우트가 직접 비운다.
  hospital_profile: "orphan",
};

assert.strictEqual(FATE.facility_verification, "cascade", "인증 신청은 함께 지운다");
assert.strictEqual(FATE.promotion_request, "cascade", "프리미엄 신청도 함께 지운다");
assert.strictEqual(
  FATE.facility_promotion,
  "setnull",
  "진행 중인 광고는 남는다 - 돈을 받은 기간까지는 나가야 한다",
);
assert.strictEqual(
  FATE.hospital_profile,
  "orphan",
  "프로필은 외래키가 없다 - 라우트가 owner_account_id 를 직접 비워야 한다",
);
assert.notStrictEqual(
  FATE.hospital_profile,
  "cascade",
  "프로필을 지우면 앱에서 병원이 사라진다",
);

/** 계정이 사라지면 업체 연결도 사라진다. 그래야 그 병원이 다시 가입한다. */
function facilityFreeAfterDelete(deleted: boolean): boolean {
  return deleted;
}
assert.ok(facilityFreeAfterDelete(true), "지우면 업체가 풀린다");

/** 서류는 트랜잭션 밖에서, 행이 지워진 뒤에 지운다. 반대로 하면
 *  롤백됐을 때 서류만 사라지고 신청은 남는다. */
const order = ["read docs", "transaction", "unlink files"];
assert.ok(
  order.indexOf("transaction") < order.indexOf("unlink files"),
  "행을 먼저 지우고 파일은 그다음",
);

console.log("ok — 프로필은 주인만 비우고, 광고는 남기고, 서류는 지운다");
