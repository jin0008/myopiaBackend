/**
 * 배너 집계와 끼워 넣기 규칙.
 *
 *   npx tsx scripts/check-banner-stats.ts
 *
 * 광고를 팔면 이 숫자를 내밀어야 한다. 부풀거나 모자라면 돈 이야기가 된다.
 */
import assert from "assert";

/** 살아 있는 배너만 센다. 꺼졌거나 기간이 지난 것은 세지 않는다. */
function countable(
  b: { active: boolean; start_at: Date | null; end_at: Date | null },
  now: Date,
): boolean {
  if (!b.active) return false;
  if (b.start_at != null && b.start_at > now) return false;
  if (b.end_at != null && b.end_at < now) return false;
  return true;
}
const now = new Date("2026-10-03T00:00:00Z");
const past = new Date("2026-09-01T00:00:00Z");
const future = new Date("2026-11-01T00:00:00Z");

assert.ok(countable({ active: true, start_at: null, end_at: null }, now), "기간 없으면 늘 센다");
assert.ok(!countable({ active: false, start_at: null, end_at: null }, now), "꺼진 것은 안 센다");
assert.ok(!countable({ active: true, start_at: future, end_at: null }, now), "아직 시작 전");
assert.ok(!countable({ active: true, start_at: null, end_at: past }, now), "이미 끝남");
assert.ok(countable({ active: true, start_at: past, end_at: future }, now), "기간 안");

/**
 * 목록에 광고를 섞는 규칙. 앱의 interleaveAds 와 같아야 한다.
 *
 * 간격이 갈수록 넓어진다: 글 2개 → 광고 → 3개 → 광고 → 4개 → 광고 …
 */
function interleave(items: string[], banners: string[]) {
  if (banners.length === 0) return items.map((item) => ({ item }) as const);
  const out: ({ item: string } | { ad: string })[] = [];
  let gap = 2;
  let since = 0;
  let shown = 0;
  items.forEach((item, i) => {
    out.push({ item });
    since += 1;
    if (since === gap && i + 1 < items.length) {
      out.push({ ad: banners[shown % banners.length] });
      shown += 1;
      since = 0;
      gap += 1;
    }
  });
  return out;
}

const posts = Array.from({ length: 23 }, (_, i) => `p${i}`);
const mixed = interleave(posts, ["A", "B"]);
const shape = mixed.map((x) => ("ad" in x ? "[광고]" : "·")).join("");
console.log("  " + shape);
// 2 → 3 → 4 → 5 → 6 번째마다. 23개면 2,5,9,14,20 뒤에 들어간다.
assert.strictEqual(mixed.filter((x) => "ad" in x).length, 5, "스물세 글이면 다섯 장");
assert.ok(!("ad" in mixed[mixed.length - 1]), "목록 끝이 광고면 안 된다");

// 앞쪽 간격이 좁고 뒤로 갈수록 넓어진다.
const gaps: number[] = [];
let run = 0;
for (const x of mixed) {
  if ("ad" in x) {
    gaps.push(run);
    run = 0;
  } else run += 1;
}
assert.deepStrictEqual(gaps, [2, 3, 4, 5, 6], "간격이 하나씩 늘어난다");

assert.strictEqual(
  interleave(["p0", "p1"], ["A"]).filter((x) => "ad" in x).length,
  0,
  "글이 둘뿐이면 광고를 넣지 않는다 - 끝에 붙는 셈이 된다",
);
assert.strictEqual(
  interleave(posts, []).filter((x) => "ad" in x).length,
  0,
  "배너가 없으면 목록은 그대로다",
);

console.log("ok — 살아 있는 배너만 세고, 간격이 2·3·4… 로 늘고, 끝은 글로 끝난다");
