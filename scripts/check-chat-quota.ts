/**
 * 채팅 하루 한도가 실제로 걸리는지 본다.
 *
 *   npx tsx scripts/check-chat-quota.ts
 *
 * 이 검사가 있는 이유: 사용량 파일을 못 쓰면 checkAndCountUsage 가 조용히
 * "ok" 를 돌려주고, 한도가 걸리지 않은 채 AI 호출이 나간다. 눈으로는 멀쩡해
 * 보이고 청구서에서만 드러난다. 실제로 그 상태로 돌고 있었다.
 *
 * 경로가 실행 위치에 휘둘리지 않는지도 함께 본다.
 */
import assert from "assert";
import fs from "fs";
import os from "os";
import path from "path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "chatq-"));
process.env.CHAT_DATA_DIR = tmp;
process.env.CHAT_GUEST_DAILY_LIMIT = "3";
process.env.CHAT_USER_DAILY_LIMIT = "10";
process.env.CHAT_TOTAL_DAILY_LIMIT = "500";

// 환경변수를 먼저 세운 뒤에 불러야 CHAT_CONFIG 가 그 값을 읽는다.
const { __chatTestHooks } = require("../src/routes/mobile") as {
  __chatTestHooks: {
    checkAndCountUsage: (t: string, k: string, kind: "user" | "guest") => string;
    kstToday: () => string;
  };
};
const { checkAndCountUsage, kstToday } = __chatTestHooks;

const today = kstToday();

// 손님 3회까지, 4회째부터 막힌다.
const guest = Array.from({ length: 4 }, () => checkAndCountUsage(today, "ip:1.2.3.4", "guest"));
assert.deepStrictEqual(guest, ["ok", "ok", "ok", "user_limit"], `손님 한도가 안 걸린다: ${guest}`);

// 다른 손님은 자기 몫을 따로 갖는다.
assert.strictEqual(checkAndCountUsage(today, "ip:5.6.7.8", "guest"), "ok", "손님끼리 몫이 섞인다");

// 로그인한 사람은 10회.
const user = Array.from({ length: 11 }, () => checkAndCountUsage(today, "u1", "user"));
assert.strictEqual(user[9], "ok", "10회째는 되어야 한다");
assert.strictEqual(user[10], "user_limit", "11회째는 막혀야 한다");

// 날짜가 바뀌면 초기화된다.
assert.strictEqual(checkAndCountUsage("2099-01-01", "ip:1.2.3.4", "guest"), "ok", "날짜가 바뀌면 풀려야 한다");

// KST 기준이라 UTC 와 다를 수 있다 - 한국 시각 0~9시 사이에는 하루 차이가 난다.
const utc = new Date().toISOString().slice(0, 10);
assert.match(today, /^\d{4}-\d{2}-\d{2}$/);
console.log(`  오늘(KST) ${today} / UTC ${utc}${today !== utc ? "  ← 다름, KST 기준이 맞다" : ""}`);

fs.rmSync(tmp, { recursive: true, force: true });
console.log("ok — 손님 3회·로그인 10회에서 막히고, 날짜가 바뀌면 풀린다");

// ── 요금 오류 판별 ───────────────────────────────────────────────
// 실제로 받은 메시지로 본다. '잠시 후 다시 시도'로 안내하면 거짓말이 되는
// 경우라, 이 판별이 빗나가면 사용자도 운영자도 원인을 모른 채 기다린다.
{
  const { isBillingError } = require("../src/routes/mobile") as {
    isBillingError: (e: string | null) => boolean;
  };
  const real =
    "Your prepayment credits are depleted. Please go to AI Studio at https://ai.studio/projects to manage your project and billing.";
  assert.ok(isBillingError(real), "2026-09-29 에 실제로 받은 메시지를 못 알아본다");
  assert.ok(isBillingError("Quota exceeded for quota metric"), "quota 를 못 알아본다");
  assert.ok(isBillingError("RESOURCE_EXHAUSTED"), "RESOURCE_EXHAUSTED 를 못 알아본다");
  assert.ok(!isBillingError("fetch: ECONNRESET"), "네트워크 오류를 요금 문제로 본다");
  // 'exceeded' 만으로 잡으면 응답 길이 초과까지 요금 문제가 된다. 그러면
  // 사용자에게 '일시 중단' 이 나가고 운영자는 멀쩡한 결제를 들여다본다.
  assert.ok(
    !isBillingError("maxOutputTokens exceeded"),
    "길이 초과를 요금 문제로 본다",
  );
  assert.ok(!isBillingError(null), "오류가 없는데 요금 문제로 본다");
  console.log("ok — 요금 오류를 네트워크 오류와 구분한다");
}
