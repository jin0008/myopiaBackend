/**
 * 배너 저장이 빈 칸을 어떻게 받는지.
 *
 *   npx tsx scripts/check-banner-input.ts
 *
 * 화면이 안 적은 칸을 "" 로 보낸다. 그대로 min(1) 에 걸리게 두면
 * 서브타이틀을 비웠다는 이유로 배너가 저장되지 않는다.
 */
import assert from "assert";
import zod from "zod";

const optionalText = zod.preprocess(
  (v) => (typeof v === "string" && v.trim() === "" ? null : v),
  zod.string().min(1).nullable().optional(),
);
const schema = zod.object({
  title: zod.string().min(1),
  subtitle: optionalText,
  badge_text: optionalText,
  image_url: zod.string().url(),
  link_url: zod.string().url(),
});

const base = {
  title: "드림렌즈 상담",
  image_url: "https://example.com/a.png",
  link_url: "https://example.com",
};

// 비워 둔 칸 — 이것이 400 으로 튕기던 경우다.
assert.ok(
  schema.safeParse({ ...base, subtitle: "", badge_text: "" }).success,
  "서브타이틀·배지를 비워도 저장된다",
);
assert.ok(schema.safeParse({ ...base, subtitle: "   " }).success, "공백만 적어도 빈 것으로 본다");
assert.strictEqual(
  schema.parse({ ...base, subtitle: "" }).subtitle,
  null,
  "빈 칸은 null 로 들어간다 - '' 를 저장하면 화면이 빈 줄을 그린다",
);
assert.ok(schema.safeParse(base).success, "아예 안 보내도 된다");
assert.strictEqual(schema.parse({ ...base, subtitle: "할인" }).subtitle, "할인", "적으면 그대로");

// 꼭 있어야 하는 칸
assert.ok(!schema.safeParse({ ...base, title: "" }).success, "제목은 비울 수 없다");
assert.ok(!schema.safeParse({ ...base, image_url: "" }).success, "이미지는 있어야 한다");
assert.ok(!schema.safeParse({ ...base, link_url: "주소아님" }).success, "링크는 주소여야 한다");

console.log("ok — 빈 칸은 null 로 받고, 꼭 필요한 칸만 막는다");
