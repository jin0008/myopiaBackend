/**
 * 병원 검색 엔드포인트가 모두 한 구현을 쓰는지 본다.
 *
 *   npx tsx scripts/check-place-routes.ts
 *
 * 같은 검색이 세 군데에 복사돼 있었다 - 운영자 등록, 병원 담당자, 파트너.
 * 명부 폴백을 두 곳에만 넣는 바람에, 정작 실제로 쓰이는 파트너 화면
 * (/api/partner/place-search)에서는 신고된 버그가 그대로 남았다.
 * 사본이 다시 생기면 여기서 걸린다.
 */
import assert from "assert";
import fs from "fs";
import path from "path";

const routes = path.join(__dirname, "../src/routes");
const files = fs.readdirSync(routes).filter((f) => f.endsWith(".ts"));

const offenders: string[] = [];
let handlers = 0;

for (const f of files) {
  const src = fs.readFileSync(path.join(routes, f), "utf8");
  for (const line of src.split("\n")) {
    if (/router\.get\(\s*"[^"]*place-search"/.test(line)) handlers++;
  }
  // 라우트 파일이 카카오 검색을 직접 부르면 사본이 생긴 것이다.
  if (src.includes("searchEyeClinics(")) offenders.push(f);
}

console.log(`place-search 라우트 ${handlers}개, 카카오를 직접 부르는 라우트 파일 ${offenders.length}개`);

assert.ok(handlers >= 3, `place-search 라우트가 ${handlers}개뿐이다 - 사라졌나?`);
assert.deepStrictEqual(
  offenders,
  [],
  `라우트가 카카오를 직접 부른다(사본 의심): ${offenders.join(", ")}. lib/placeSearch 의 findPlaces 를 써라.`,
);

console.log("ok — 세 엔드포인트가 모두 findPlaces 하나를 쓴다");
