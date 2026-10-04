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

/**
 * 메일에 적는 날짜는 KST 로 읽는다.
 *
 * 기간 끝은 KST 23:59:59(= UTC 14:59:59)라 UTC 로 자르면 같은 날이지만,
 * 자정에 끝나는 기간은 하루 전으로 적힌다. 업체가 받는 글에 틀린 날짜가
 * 적히면 "하루 손해 봤다"는 문의가 된다.
 */
function korean(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${y}년 ${Number(m)}월 ${Number(d)}일`;
}
assert.strictEqual(korean("2026-11-03"), "2026년 11월 3일", "0 을 떼고 읽는다");
assert.strictEqual(korean("2026-01-01"), "2026년 1월 1일");

console.log("ok — 날짜는 한국식으로");
