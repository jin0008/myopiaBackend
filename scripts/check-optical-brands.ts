/**
 * 취급 브랜드가 맞는 곳에만 붙는지.
 *
 *   npx tsx scripts/check-optical-brands.ts
 *
 * 상표다. 취급하지 않는 곳에 붙으면 허위 표시이고, 브랜드사 입장에서는
 * 상표 오용이다.
 */
import assert from "assert";

const BRANDS = ["miyosmart", "stellest"] as const;

/** 업종이 정한다. 근시조절 렌즈는 안경원이 파는 것이다. */
function brandsFor(kind: "eye" | "optical", picked: string[] | undefined) {
  return kind === "optical" ? (picked ?? []) : [];
}
assert.deepStrictEqual(brandsFor("optical", ["stellest"]), ["stellest"]);
assert.deepStrictEqual(brandsFor("optical", undefined), [], "안 고르면 빈 배열");
assert.deepStrictEqual(
  brandsFor("eye", ["stellest"]),
  [],
  "병원이 보내도 받지 않는다 - 안경 렌즈 브랜드다",
);

/** 아는 브랜드만 받는다. 자유 입력이면 "스텔레스트"/"Stellest 렌즈"로
 *  갈려 같은 브랜드가 여러 개가 된다. */
function accepted(v: string): boolean {
  return (BRANDS as readonly string[]).includes(v);
}
assert.ok(accepted("stellest"));
assert.ok(!accepted("스텔리스트"), "한글 표기는 안 받는다");
assert.ok(!accepted("STELLEST"), "대소문자도 한 가지로");

/** 승인에 들어가는 것은 운영자가 확인한 값이다. 신청자가 고른 것을
 *  그대로 쓰면, 체크만 하면 로고가 붙는 셈이 된다. */
function onApprove(operatorPicked: string[] | undefined, applicantPicked: string[]) {
  return operatorPicked ?? [];
}
assert.deepStrictEqual(
  onApprove([], ["stellest"]),
  [],
  "운영자가 뺐으면 빠진다 - 신청자가 골랐어도",
);
assert.deepStrictEqual(onApprove(["miyosmart"], []), ["miyosmart"], "운영자가 더할 수도 있다");

/** 명부(optical_shop)에는 넣지 않는다. 공공데이터라 다음 갱신에 지워진다. */
const storedOn = "hospital_account";
assert.notStrictEqual(storedOn, "optical_shop", "명부에 쓰면 갱신 때 지워진다");

console.log("ok — 안경원에만, 아는 브랜드만, 운영자가 확인한 것만 붙는다");
