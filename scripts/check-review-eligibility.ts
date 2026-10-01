/**
 * 리뷰 작성 자격과 배지 규칙.
 *
 *   npx tsx scripts/check-review-eligibility.ts
 *
 * 자격을 넓히는 변경이라 조심해야 한다. 너무 넓히면 아무 데나 글이 붙고,
 * 배지가 잘못 붙으면 환자가 아닌 글이 환자 글로 읽힌다.
 */
import assert from "assert";

/** POST 가 거절하는 유일한 경우: 쓸 페이지가 없다. 자격 문제가 아니다. */
function rejects(profile: { status: string } | null): boolean {
  return profile == null || profile.status !== "published";
}
assert.ok(rejects(null), "프로필이 없으면 쓸 곳이 없다");
assert.ok(rejects({ status: "pending" }), "내려가 있으면 쓸 곳이 없다");
assert.ok(!rejects({ status: "published" }), "올라가 있으면 쓸 수 있다");

/** 배지는 쓰는 시점에 굳힌다. 읽을 때마다 다시 재면 아이를 지운 뒤에
 *  옛 글의 배지가 조용히 사라진다 - 그때 쓴 사람은 분명히 환자였다. */
function onCreate(patientHospitalId: string | null) {
  return {
    hospital_id: patientHospitalId,
    verified_patient: patientHospitalId != null,
  };
}
assert.deepStrictEqual(
  onCreate("HOSP-1"),
  { hospital_id: "HOSP-1", verified_patient: true },
  "환자면 배지가 붙고 병원도 남는다",
);
assert.deepStrictEqual(
  onCreate(null),
  { hospital_id: null, verified_patient: false },
  "환자가 아니면 배지도 병원도 없다",
);

/** 화면이 작성칸을 보여 주는 기준. 예전에는 환자인지까지 봤는데, 조건을
 *  다 넘는 사람이 거의 없어 리뷰가 한 건도 쌓이지 않았다. */
function reviewable(viewerId: string | null): boolean {
  return viewerId != null;
}
assert.ok(reviewable("u1"), "로그인했으면 쓸 수 있다");
assert.ok(!reviewable(null), "손님은 못 쓴다 - 익명 글은 막는다");

/** 한 사람이 한 병원에 한 번. 이건 그대로다(unique 인덱스). */
console.log("ok — 올라간 프로필에 로그인한 사람이면 쓰고, 환자였던 글에만 배지가 붙는다");
