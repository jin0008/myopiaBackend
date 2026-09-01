/**
 * 만료된 이메일 인증 코드를 지운다.
 *
 * 주기적으로 돌린다(감사 로그 정리와 같은 자리):
 *   node dist/scripts/purge-expired-verification-codes.js
 *
 * 만료 후 하루는 남긴다. 사용자가 "코드가 안 맞는다"고 문의했을 때
 * 언제 발급됐고 몇 번 틀렸는지 확인할 수 있어야 한다. 코드 자체는 해시라
 * 남아 있어도 쓸 수 없다.
 */
import "dotenv/config";

import { purgeExpiredCodes } from "../services/emailVerification";
import prisma from "../lib/prisma";

async function main() {
  const count = await purgeExpiredCodes();
  console.log(`[purge-expired-verification-codes] deleted ${count} row(s)`);
}

main()
  .catch((err) => {
    console.error("[purge-expired-verification-codes] failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
