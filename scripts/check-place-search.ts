/**
 * 프로필 등록 검색이 안과 아닌 분류를 버리지 않는지 본다.
 *
 *   npx tsx scripts/check-place-search.ts
 *
 * 눈편한성모안과의원은 카카오에서 "일반의원"이다. 같은 검색어에 진짜
 * 안과가 함께 걸릴 때 이런 병원이 사라지던 것이 버그였다.
 */
import assert from "assert";
import { rankEyeClinics } from "../src/lib/kakaoPlaces";

const docs = [
  { id: "1", category_name: "의료,건강 > 병원 > 안과", place_name: "눈편한안과" },
  { id: "2", category_name: "의료,건강 > 병원 > 일반의원", place_name: "눈편한성모안과의원" },
  { id: "3", category_name: "음식점 > 카페", place_name: "눈편한카페" },
];

const ranked = rankEyeClinics(docs, 10);

// 안과가 먼저 온다.
assert.strictEqual(ranked[0].id, "1", "안과가 맨 앞이어야 한다");
// 안과가 있어도 일반의원이 살아남는다 — 이게 고친 부분이다.
assert.ok(
  ranked.some((d) => d.id === "2"),
  "안과가 걸렸다고 일반의원을 버리면 안 된다",
);
// limit 은 지킨다.
assert.strictEqual(rankEyeClinics(docs, 2).length, 2, "limit 을 넘기면 안 된다");

console.log("ok — 안과 우선, 나머지 유지");
