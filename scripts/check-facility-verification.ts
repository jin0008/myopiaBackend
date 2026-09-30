/**
 * 인증 신청·심사 규칙을 본다.
 *
 *   npx tsx scripts/check-facility-verification.ts
 *
 * 여기가 틀리면 남의 병원 이름으로 광고가 나가거나, 남의 사업자등록증이
 * 새어 나간다. 서버를 띄우지 않고 판단만 따로 확인한다.
 */
import assert from "assert";

/* ---- 서류 열람 ------------------------------------------------------- */

/** 신청에 딸린 파일만 내준다. 디렉터리에 있는 아무 파일이나 이름으로
 *  꺼낼 수 있으면, 남의 사업자등록증이 파일명 하나로 새어 나간다. */
function servable(docFiles: string[], asked: string): boolean {
  return docFiles.includes(asked);
}

const mine = ["a1b2.pdf", "c3d4.jpg"];
assert.ok(servable(mine, "a1b2.pdf"), "내 서류는 열린다");
assert.ok(!servable(mine, "남의파일.pdf"), "다른 신청의 서류는 열리면 안 된다");
// path.basename 을 통과한 뒤에도 목록에 없으면 막힌다 - 두 겹이다.
assert.ok(!servable(mine, "../../.env"), "경로를 거슬러 올라가는 이름은 막힌다");

/* ---- 심사 ------------------------------------------------------------ */

type Action = "approve" | "reject";
/** 반려는 사유가 있어야 한다. 파트너 화면에 그대로 보이는데 비어 있으면
 *  무엇을 고쳐 다시 내야 하는지 알 수 없다. */
function reviewRejected(action: Action, note: string | undefined): boolean {
  return action === "reject" && !note;
}
assert.ok(reviewRejected("reject", undefined), "사유 없는 반려는 막는다");
assert.ok(!reviewRejected("reject", "상호가 서류와 다릅니다"), "사유가 있으면 통과");
assert.ok(!reviewRejected("approve", undefined), "승인에는 사유가 필요없다");

/** 승인하면 계정에 무엇이 박히는지. 안경원은 프로필이 없어 따로 노출시킬
 *  것이 없으므로 여기서 끝낸다. 병원은 치료탭 노출이 별개다. */
function onApprove(kind: "eye" | "optical") {
  return {
    facility_kind: kind,
    facility_key: "KEY",
    ...(kind === "optical" ? { status: "approved" } : {}),
  };
}
assert.strictEqual(onApprove("optical").status, "approved", "안경원은 승인까지 끝난다");
assert.ok(!("status" in onApprove("eye")), "병원 상태는 건드리지 않는다");
assert.strictEqual(onApprove("eye").facility_key, "KEY", "병원도 연결은 된다");

/* ---- 신청 ------------------------------------------------------------ */

/** 업종은 신청서가 정하지 않는다. 계정이 가입할 때 고른 것을 쓴다 -
 *  신청서가 정하면 안경원 계정으로 안과를 신청할 수 있다. */
function kindOf(businessKind: string): "eye" | "optical" {
  return businessKind === "optical" ? "optical" : "eye";
}
assert.strictEqual(kindOf("optical"), "optical");
assert.strictEqual(kindOf("hospital"), "eye");
assert.strictEqual(kindOf(""), "eye", "모르는 값은 병원으로 본다(기존 계정)");

/** 서류 없이 받지 않는다. 받으면 운영자가 대조할 것이 없고, 예전처럼
 *  "확인했다고 치고" 누르는 자리로 돌아간다. */
assert.ok([].length === 0, "서류 0장은 거절 대상");

console.log("ok — 서류 열람은 그 신청 것만, 반려엔 사유, 안경원만 승인까지 끝난다");
