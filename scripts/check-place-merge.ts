/**
 * 카카오 결과와 명부 결과를 합치는 규칙을 본다.
 *
 *   npx tsx scripts/check-place-merge.ts
 *
 * 원래 버그가 여기서 되살아난다. 폴백을 "카카오가 0건일 때만" 으로 두면
 * "눈편한" 검색에 카카오가 눈편한안과를 돌려주므로 0건이 아니고, 정작
 * 찾던 눈편한성모안과의원(카카오 색인에 없다)은 끝내 나오지 않는다.
 */
import assert from "assert";
import { mergePlaces } from "../src/lib/placeSearch";

// 카카오가 "눈편한" 에 실제로 돌려주는 것들 (어드민 화면에서 확인한 값)
const kakao = [{ name: "눈이편한안과" }, { name: "눈편한안과" }];
// 명부에서 같은 검색어로 걸리는 것들
const directory = [{ name: "눈편한안과의원" }, { name: "눈편한성모안과의원" }];

const merged = mergePlaces(kakao, directory);
const names = merged.map((p) => p.name);

// 신고된 버그: 카카오가 결과를 냈어도 명부의 그 병원이 나와야 한다.
assert.ok(names.includes("눈편한성모안과의원"), "명부에만 있는 병원이 빠졌다");
// 카카오 결과가 앞에 온다 - 그쪽 id 가 이 앱의 원래 열쇠다.
assert.strictEqual(names[0], "눈이편한안과", "카카오 결과가 앞이어야 한다");

// 띄어쓰기만 다른 같은 병원은 한 번만 나온다.
const dedup = mergePlaces([{ name: "눈편한 성모안과" }], [{ name: "눈편한성모안과" }]);
assert.strictEqual(dedup.length, 1, "띄어쓰기만 다른 같은 병원이 두 번 나온다");

// 카카오가 0건이어도 명부가 살아 있다.
assert.strictEqual(mergePlaces([], directory).length, 2);

console.log("ok — 카카오가 결과를 내도 명부의 병원이 함께 나온다");
