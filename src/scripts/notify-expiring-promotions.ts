/**
 * 광고 기간이 끝나 가는 파트너에게 알린다.
 *
 *   node dist/scripts/notify-expiring-promotions.js
 *
 * 하루에 한 번 돌린다(systemd timer).
 *
 * 자동 청구가 아니다. 나이스 V2 결제창에는 카드 등록(빌링키 발급)이 없고,
 * 빌링키는 카드번호를 우리가 직접 받아 암호화해 보내야만 나온다. 소아
 * 의료 자료를 들고 있는 서버에 카드번호까지 얹을 일이 아니라, 지금은
 * 알려 주고 파트너가 직접 연장하게 한다.
 *
 * 받는 쪽이 준비되면(인증형 빌키발급 상품) 여기에 청구를 붙이면 된다 -
 * 기간 계산과 결제 기록은 직접 결제와 같은 것을 쓰고 있다.
 */
import "dotenv/config";

import prisma from "../lib/prisma";
import { sendEmail } from "../services/email";

/** 며칠 전에 알릴지. 하루 이틀로는 결제를 올릴 시간이 모자란다. */
const NOTICE_DAYS = 7;
const PARTNER_URL =
  (process.env.PARTNER_ORIGIN ?? "https://myopiamanage.org") + "/partner/promotions";

function won(n: number): string {
  return n.toLocaleString("ko-KR") + "원";
}

async function main() {
  const now = new Date();
  const until = new Date(now.getTime() + NOTICE_DAYS * 24 * 3600 * 1000);

  const rows = await prisma.subscription.findMany({
    where: {
      current_period_end: { gt: now, lte: until },
      // 한 번은 결제한 적이 있어야 한다. 결제 없이 운영자가 걸어 준
      // 광고에 "연장하시겠습니까" 를 보내면 받은 적 없는 돈을 달라는 꼴이다.
      payments: { some: { status: "paid" } },
    },
    include: { account: { select: { email: true, hospital_name: true } } },
  });

  for (const s of rows) {
    // 같은 주기에 두 번 보내지 않는다. 매일 도는 일이라 안 막으면 7통이 간다.
    if (
      s.notified_for != null &&
      s.notified_for.getTime() === s.current_period_end.getTime()
    ) {
      continue;
    }
    const on = s.current_period_end.toISOString().slice(0, 10);
    try {
      await sendEmail(
        [s.account.email],
        "[마이오닥] 프리미엄 노출 기간이 곧 끝납니다",
        `<p>${s.account.hospital_name} 님,</p>
         <p>프리미엄 노출이 <b>${on}</b>까지입니다. 그 뒤로는 찾기 탭 상단 노출이
            멈추고, 결제하시면 다시 시작됩니다.</p>
         <p>연장은 파트너 페이지에서 하실 수 있습니다. 현재 요금은
            한 달 ${won(s.amount)}입니다.</p>
         <p><a href="${PARTNER_URL}">${PARTNER_URL}</a></p>
         <p>자동으로 결제되는 것은 없습니다. 연장하지 않으시면 기간이 끝나고
            그대로 멈춥니다.</p>`,
      );
    } catch (err) {
      // 주소가 하나 틀렸다고 뒤에 줄 선 업체들까지 못 받으면 안 된다.
      console.error("[광고] 메일 실패", s.account.email, err);
      continue;
    }
    await prisma.subscription.update({
      where: { id: s.id },
      data: { notified_for: s.current_period_end, updated_at: new Date() },
    });
    console.log(`[광고] 만료 안내 ${s.account.hospital_name} ${on}`);
  }
}

main()
  .catch((err) => {
    console.error("[광고] 실패", err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
