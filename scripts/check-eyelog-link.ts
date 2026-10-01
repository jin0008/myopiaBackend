/**
 * 아이로그 연동이 인증 심사에서 제대로 흐르는지.
 *
 *   npx tsx scripts/check-eyelog-link.ts
 *
 * 이 값이 후기 작성 자격을 연다. 잘못 붙으면 남의 병원 환자에게 자격이
 * 생기고, 안 붙으면 병원은 후기가 왜 안 되는지 알 수 없다.
 */
import assert from "assert";

/** 승인할 때 계정에 쓰는 값. 안경원에는 임상 병원이라는 것이 없다. */
function onApprove(kind: "eye" | "optical", picked: string | null | undefined) {
  return kind === "eye" ? (picked ?? null) : null;
}
assert.strictEqual(onApprove("eye", "H-1"), "H-1", "병원은 고른 값을 쓴다");
assert.strictEqual(onApprove("eye", null), null, "비우면 연동 안 함");
assert.strictEqual(onApprove("eye", undefined), null, "안 보내도 연동 안 함");
assert.strictEqual(onApprove("optical", "H-1"), null, "안경원에는 안 붙는다");

/**
 * 프로필이 읽는 값은 계정에 잡아 둔 것을 따라간다.
 *
 * 승인이 프로필보다 먼저일 수 있다 - 그때 운영자가 고른 병원을 계정에
 * 두었다가, 프로필이 생기는 순간 옮긴다. 이 순서가 깨지면 "분명히
 * 연결했는데 후기가 안 된다"가 된다.
 */
function profileHospitalId(accountEyelogId: string | null): string | null {
  return accountEyelogId;
}
assert.strictEqual(profileHospitalId("H-1"), "H-1", "승인 → 나중에 프로필 생성");
assert.strictEqual(profileHospitalId(null), null, "연동 안 한 병원");

/** 파트너는 이 값을 보낼 수 없다. 후기 자격이 여기서 나오므로 스스로
 *  켤 수 있으면 안 된다 - 자기 병원에 좋은 후기를 직접 달 수 있게 된다. */
const partnerFields = [
  "kakao_place_id", "name", "description", "banner_image_url", "images",
  "phone", "address", "thumbnail_url", "keywords", "treatment_categories",
  "treatment_items", "opening_hours", "doctors", "tagline", "detail_blocks",
  "booking_url",
];
assert.ok(!partnerFields.includes("hospital_id"), "파트너는 hospital_id 를 못 보낸다");
assert.ok(!partnerFields.includes("verified"), "파트너는 verified 를 못 보낸다");

console.log("ok — 승인에서 정하고, 프로필은 계정에 잡아 둔 것을 따라간다");
