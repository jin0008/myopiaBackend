/**
 * 광고 표가 제대로 붙는지 본다.
 *
 *   npx tsx scripts/check-promotion-mark.ts
 *
 * id 형식이 어긋나면 표가 아무 데도 안 붙는데, 목록은 멀쩡히 나오므로
 * 화면만 보고는 모른다. 돈을 낸 업체가 조용히 일반 카드로 나간다.
 */
import assert from "assert";

/** markPromoted 의 키 변환과 같은 식. 저쪽을 고치면 여기도 고친다. */
function keyOf(kind: string, key: string): string {
  return `${kind === "eye" ? "hira" : "opt"}:${key}`;
}

// 명부 DTO 의 id 는 clinicToDTO / shopToDTO 가 만든다.
assert.strictEqual(keyOf("eye", "JDQ4MTYy"), "hira:JDQ4MTYy", "안과는 hira: 접두사");
assert.strictEqual(
  keyOf("optical", "PHMB220013010033082200015"),
  "opt:PHMB220013010033082200015",
  "안경원은 opt: 접두사",
);
// facility_promotion.kind 는 "eye" | "optical" 인데 DTO 접두사는 "hira" | "opt" 다.
// 그대로 맞추면 안과 광고가 영영 안 붙는다.
assert.notStrictEqual(keyOf("eye", "X"), "eye:X", "kind 를 그대로 쓰면 안 된다");

function mark<T extends { id: string }>(
  list: T[],
  rows: { kind: string; key: string; tier: string }[],
) {
  const tierOf = new Map(rows.map((r) => [keyOf(r.kind, r.key), r.tier]));
  return list.map((f) => {
    const tier = tierOf.get(f.id);
    return tier == null ? f : { ...f, promotion: { tier } };
  });
}

const list = [
  { id: "opt:AAA", name: "광고 중" },
  { id: "opt:BBB", name: "광고 안 함" },
  { id: "hira:CCC", name: "광고 중인 안과" },
];
const out = mark(list, [
  { kind: "optical", key: "AAA", tier: "premium" },
  { kind: "eye", key: "CCC", tier: "premium" },
]) as any[];

assert.deepStrictEqual(out[0].promotion, { tier: "premium" }, "광고 안경원에 표");
assert.ok(!("promotion" in out[1]), "광고 안 한 곳에는 표가 없다");
assert.deepStrictEqual(out[2].promotion, { tier: "premium" }, "광고 안과에도 표");
// 순서는 건드리지 않는다 - 표만 다는 일이다.
assert.deepStrictEqual(out.map((f) => f.id), list.map((f) => f.id), "순서 그대로");

console.log("ok — 광고 중인 곳에만 표가 붙고, 순서는 그대로다");

/**
 * 광고 자리 순서는 결제순이다.
 *
 * 자리가 셋뿐이라 거리로 자르면 돈을 낸 업체가 사용자 위치에 따라 어떤
 * 날은 아예 안 나간다. 먼저 결제한 곳이 위로 가고, 같은 때 걸린 것끼리만
 * 가까운 쪽을 위에 둔다.
 */
const AD_SLOTS = 3;
function adOrder(
  ads: { id: string; distanceKm: number; boughtAt: number }[],
): string[] {
  return [...ads]
    .sort((a, b) =>
      a.boughtAt !== b.boughtAt
        ? a.boughtAt - b.boughtAt
        : a.distanceKm - b.distanceKm,
    )
    .slice(0, AD_SLOTS)
    .map((a) => a.id);
}

assert.deepStrictEqual(
  adOrder([
    { id: "먼곳-먼저결제", distanceKm: 4.5, boughtAt: 100 },
    { id: "가까운곳-나중결제", distanceKm: 0.2, boughtAt: 200 },
  ]),
  ["먼곳-먼저결제", "가까운곳-나중결제"],
  "가까워도 나중에 결제했으면 아래",
);

assert.deepStrictEqual(
  adOrder([
    { id: "A", distanceKm: 3, boughtAt: 100 },
    { id: "B", distanceKm: 1, boughtAt: 100 },
  ]),
  ["B", "A"],
  "같은 때 결제했으면 가까운 쪽이 위",
);

// 네 번째부터는 자리가 없다. 같은 동네에 넷을 팔면 한 곳은 돈을 내고도
// 광고 자리에 못 나간다 - 파는 쪽에서 막아야 하는 일이다.
assert.deepStrictEqual(
  adOrder([
    { id: "1", distanceKm: 1, boughtAt: 1 },
    { id: "2", distanceKm: 1, boughtAt: 2 },
    { id: "3", distanceKm: 1, boughtAt: 3 },
    { id: "4", distanceKm: 0.1, boughtAt: 4 },
  ]),
  ["1", "2", "3"],
  "늦게 산 곳은 가까워도 자리가 없다",
);

console.log("ok — 광고 자리는 결제순, 같은 때면 가까운 순");
