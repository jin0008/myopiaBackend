/**
 * 원고의 *참고:* 줄을 출처로 읽는 규칙.
 *
 *   npx tsx scripts/check-citations.ts
 */
import assert from "assert";

import { citationsOf, stripReviewNotes } from "../src/lib/citations";

const body = [
  "본문입니다.",
  "",
  "*참고: LAMP 연구 https://pubmed.ncbi.nlm.nih.gov/32019700/ ; ATOM2 https://a.org/x — [검수 필요: 효과 표현 수위]*",
  "",
  "*참고: Donovan L 등, Optometry and Vision Science 2012;89(1):27-32 — [출처 상이/맥락차: 3~6개월 vs 6개월~1년]*",
  "*참고: 중복 https://pubmed.ncbi.nlm.nih.gov/32019700/*",
].join("\n");

assert.deepStrictEqual(citationsOf(body), [
  { title: "LAMP 연구", url: "https://pubmed.ncbi.nlm.nih.gov/32019700/" },
  { title: "ATOM2", url: "https://a.org/x" },
  // 논문 서지의 ";" 는 가르지 않는다 - 원고는 " ; " 로 가른다.
  { title: "Donovan L 등, Optometry and Vision Science 2012;89(1):27-32", url: "" },
]);

assert.strictEqual(
  stripReviewNotes("*참고: AAO https://a.org — [검수 필요: 표현 수위]*"),
  "*참고: AAO https://a.org*",
);
assert.deepStrictEqual(citationsOf("참고 줄 없는 카페 글"), []);

console.log("check-citations ok");
