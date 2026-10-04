/**
 * 만료 안내 메일 규칙.
 *
 *   npx tsx scripts/check-renewal-notice.ts
 */
import assert from "assert";

const NOTICE_DAYS = 7;

/** 안내 대상. 끝나기 7일 안에 든 것만. 이미 끝난 것은 보내 봐야 늦었다. */
function inWindow(end: Date, now: Date): boolean {
  const until = new Date(now.getTime() + NOTICE_DAYS * 24 * 3600 * 1000);
  return end > now && end <= until;
}
const now = new Date("2026-10-28T00:00:00Z");
assert.ok(inWindow(new Date("2026-11-03T14:59:59Z"), now), "엿새 뒤면 알린다");
assert.ok(!inWindow(new Date("2026-12-03T14:59:59Z"), now), "한 달 남았으면 아직");
assert.ok(!inWindow(new Date("2026-10-01T00:00:00Z"), now), "이미 끝났으면 안 보낸다");

/** 주기마다 한 번. 매일 도는 일이라 안 막으면 7통이 간다. */
function shouldSend(notifiedFor: Date | null, end: Date): boolean {
  return notifiedFor == null || notifiedFor.getTime() !== end.getTime();
}
const end = new Date("2026-11-03T14:59:59Z");
assert.ok(shouldSend(null, end), "아직 안 보냈으면 보낸다");
assert.ok(!shouldSend(end, end), "같은 주기에 또 보내지 않는다");
assert.ok(shouldSend(end, new Date("2026-12-03T14:59:59Z")), "연장하면 다음 주기에 다시");

console.log("ok — 끝나기 7일 전에 한 번만, 돈을 낸 곳에만");
