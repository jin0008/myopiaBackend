/**
 * 처방전 사진에서 읽은 값을 거르는 규칙을 본다.
 *
 *   npx tsx scripts/check-prescription-ocr.ts
 *
 * 모델이 잘못 읽은 값(범위 밖 도수, 소수 축, 엉뚱한 날짜)이 칸에 채워지면
 * 보호자가 그대로 저장하기 쉽다. 그런 값은 비워서 돌려줘야 한다.
 */
import assert from "assert";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { __chatTestHooks } = require("../src/routes/mobile") as {
  __chatTestHooks: { cleanOcr: (raw: Record<string, unknown>) => Record<string, unknown> };
};
const { cleanOcr } = __chatTestHooks;

assert.deepStrictEqual(
  cleanOcr({
    prescribedOn: "2026-09-02",
    sphOd: -2.25,
    cylOd: -0.5,
    axisOd: 180,
    sphOs: -2.3, // 0.25 단위로 맞춘다
    cylOs: 45, // 범위 밖 - 축을 원주 칸에 읽은 경우
    axisOs: 90.5, // 정수가 아니다
  }),
  {
    prescribedOn: "2026-09-02",
    sphOd: -2.25,
    sphOs: -2.25,
    cylOd: -0.5,
    cylOs: null,
    axisOd: 180,
    axisOs: null,
  },
);
assert.deepStrictEqual(cleanOcr({ prescribedOn: "26.9.2", sphOd: "-1.00" }), {
  prescribedOn: null,
  sphOd: null,
  sphOs: null,
  cylOd: null,
  cylOs: null,
  axisOd: null,
  axisOs: null,
});
console.log("ok");
process.exit(0);
