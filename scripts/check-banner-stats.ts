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

/** 목록에 광고를 섞는 규칙. 앱의 interleaveAds 와 같아야 한다. */
const AD_EVERY = 5;
function interleave(items: string[], banners: string[]) {
  if (banners.length === 0) return items.map((item) => ({ item }) as const);
  const out: ({ item: string } | { ad: string })[] = [];
  let shown = 0;
  items.forEach((item, i) => {
    out.push({ item });
    if ((i + 1) % AD_EVERY === 0 && i + 1 < items.length) {
      out.push({ ad: banners[shown % banners.length] });
      shown += 1;
    }
  });
  return out;
}
const posts = Array.from({ length: 12 }, (_, i) => `p${i}`);
const mixed = interleave(posts, ["A", "B"]);
assert.strictEqual(mixed.filter((x) => "ad" in x).length, 2, "열두 글이면 두 장");
assert.ok(!("ad" in mixed[mixed.length - 1]), "목록 끝이 광고면 안 된다");
assert.strictEqual(
  interleave(["p0", "p1", "p2"], ["A"]).filter((x) => "ad" in x).length,
  0,
  "글이 다섯 개가 안 되면 광고를 넣지 않는다",
);
assert.strictEqual(
  interleave(posts, []).filter((x) => "ad" in x).length,
  0,
  "배너가 없으면 목록은 그대로다",
);

console.log("ok — 살아 있는 배너만 세고, 다섯 글마다 한 장, 끝은 글로 끝난다");
