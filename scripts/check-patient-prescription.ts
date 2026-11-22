/**
 * 병원 처방전 입력 검증.
 *
 *   npx tsx scripts/check-patient-prescription.ts
 *
 * 처방전은 인쇄돼 안경원으로 간다. 0.3D 같은 오타나 방향 없는 프리즘이
 * 그대로 찍히면 안경이 잘못 만들어진다.
 */
import assert from "assert";
import { postSchema } from "../src/routes/patientPrescription";

const base = {
  registration_number: " 12345 ",
  date_of_birth: "2015-03-02",
  sex: "male",
  prescribed_on: "2026-11-20",
};
const ok = (x: object) => postSchema.safeParse({ ...base, ...x }).success;

assert.ok(ok({}), "도수 없이도 발행(비워 두기)");
assert.equal(postSchema.parse(base).registration_number, "12345", "등록번호 앞뒤 공백 제거");
assert.ok(ok({ far: { sph_od: -2.75, cyl_od: -0.5, axis_od: 180 } }));
assert.ok(!ok({ far: { sph_od: -2.3 } }), "0.25 단위가 아니면 거절");
assert.ok(!ok({ far: { sph_od: -31 } }), "범위 밖 SPH");
assert.ok(!ok({ far: { cyl_od: -1 } }), "CYL 만 있고 축이 없으면 거절");
assert.ok(ok({ far: { cyl_od: 0 } }), "CYL 0 은 축 없어도 됨");
assert.ok(!ok({ near: { prism_os: 2 } }), "프리즘에 BASE 가 없으면 거절");
assert.ok(ok({ near: { prism_os: 2, base_os: "BI" } }));
assert.ok(!ok({ near: { prism_os: 2, base_os: "XX" } }), "모르는 BASE");
assert.ok(!ok({ pd_far: 30 }), "PD 범위");
assert.ok(ok({ add_od: 1.5, add_os: 1.5 }));
assert.ok(!ok({ add_od: 4.25 }), "ADD 범위");
assert.ok(!ok({ prescribed_on: "2999-01-01" }), "미래 발행일 거절");
assert.ok(!ok({ date_of_birth: "2015-13-01" }), "없는 날짜");

console.log("ok");
