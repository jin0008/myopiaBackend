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
