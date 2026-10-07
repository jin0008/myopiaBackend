/**
 * 광고 기간이 끝나 가는 파트너에게 알린다.
 *
 *   node dist/scripts/notify-expiring-promotions.js
 *
 * 하루에 한 번 돌린다(systemd timer).
 *
 * 하는 일은 셋이다. 순서가 중요하다.
 *
 *   1. 자동결제 갱신 — 끝나기 하루 안쪽인 구독을 등록된 카드로 청구한다
 *      (services/billing.ts). 동을 비우기 전에 해야 이어 내는 업체의 동이
 *      잠깐이라도 풀리지 않는다.
 *   2. 끝난 광고의 동 비우기
 *   3. 7일 전 안내 — 자동결제면 "결제 예정", 아니면 "직접 연장" 안내
 *
 * 1·2 는 메일 설정과 무관하게 돈다. 메일이 안 된다고 청구를 건너뛰면
 * 이어 내려던 업체의 광고가 끊긴다.
 */
import "dotenv/config";

import prisma from "../lib/prisma";
import { kstDateString } from "../lib/promotionTerm";
import { isEmailConfigured, sendEmail } from "../services/email";
import { renewDueSubscriptions } from "../services/billing";

/** 며칠 전에 알릴지. 하루 이틀로는 결제를 올릴 시간이 모자란다. */
const NOTICE_DAYS = 7;
const PARTNER_URL =
  (process.env.PARTNER_ORIGIN ?? "https://myopiamanage.org") + "/partner/promotions";

function won(n: number): string {
  return n.toLocaleString("ko-KR") + "원";
}

/** "2026년 11월 3일". 업체가 읽을 글이라 숫자만 늘어놓지 않는다. */
function korean(d: Date): string {
  const [y, m, day] = kstDateString(d).split("-");
  return `${y}년 ${Number(m)}월 ${Number(day)}일`;
}

/**
 * 기간이 끝난 광고가 쥐고 있던 동을 내놓는다.
 *
 * 자리는 DB 유니크(kind, region_code)가 지킨다. 끝난 광고가 코드를 그대로
 * 들고 있으면 그 동은 영영 다시 팔리지 않는다 - 안 파는 것이 아니라 아무도
 * 살 수 없게 된다.
 *
 * 이름(region_name)은 남긴다. 이력에서 "어느 동을 샀던 곳인가"가 사라지면
 * 지난 계약을 읽을 수 없다.
 */
async function releaseExpiredRegions(now: Date): Promise<void> {
  const done = await prisma.facility_promotion.updateMany({
    where: { ends_at: { lt: now }, region_code: { not: null } },
    data: { region_code: null, updated_at: new Date() },
  });
  if (done.count > 0) console.log(`[광고] 끝난 광고 ${done.count}건의 동을 비웠다`);
}

async function main() {
  // 갱신이 맨 먼저다. 메일이 없으면 결과 안내만 건너뛴다.
  await renewDueSubscriptions(new Date(), async (to, subject, html) => {
    if (!isEmailConfigured()) {
      console.warn("[갱신] SMTP 가 없어 안내를 보내지 못했다", to, subject);
      return;
    }
    await sendEmail([to], subject, html);
  });

  // 자리 비우기가 그다음이다. 메일 설정이 없다고 아래에서 돌아가 버리면, 끝난
  // 광고가 동을 쥔 채로 남아 그 동이 영영 안 팔린다.
  await releaseExpiredRegions(new Date());

  // sendEmail 은 SMTP 가 없으면 경고만 남기고 조용히 돌아간다. 그대로
  // 두면 아래에서 "보냈다"고 적어 두게 되고(notified_for), 그 주기의
  // 안내는 영영 다시 나가지 않는다 - 한 통도 못 보낸 채로.
  if (!isEmailConfigured()) {
    console.error("[광고] SMTP 가 설정돼 있지 않다. 아무것도 하지 않는다.");
    process.exitCode = 1;
    return;
  }
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
    const on = korean(s.current_period_end);
    // 자동결제 중이면 "연장하세요"가 아니라 "빠져나갑니다"를 미리 알린다.
    // 전자상거래법상 정기결제는 결제 전에 알려야 한다.
    const auto = s.auto_renew && s.billing_key != null;
    try {
      await sendEmail(
        [s.account.email],
        auto ? "[마이오닥] 자동결제 예정 안내" : "[마이오닥] 프리미엄 노출 기간 안내",
        auto
          ? `<p>${s.account.hospital_name} 님, 안녕하세요.</p>
         <p>이용 중인 프리미엄 노출이 <b>${on}</b>에 갱신되며, 등록하신 카드로
            <b>${won(s.amount)}</b>이 자동 결제될 예정입니다.</p>
         <p>더 이용하지 않으시려면 그 전에 파트너 페이지에서 자동결제를 해지해
            주세요. 해지해도 ${on}까지는 그대로 노출됩니다.</p>
         <p><a href="${PARTNER_URL}">${PARTNER_URL}</a></p>
         <p>감사합니다.</p>`
          :
        `<p>${s.account.hospital_name} 님, 안녕하세요.</p>
         <p>현재 이용 중인 프리미엄 노출 기간이 <b>${on}</b>에 종료됩니다.</p>
         <p>기간이 끝나면 찾기 탭 상단 노출이 중단되며, 계속 이용을 원하실 경우
            파트너 페이지에서 연장하실 수 있습니다.</p>
         <p>현재 이용 요금은 월 ${won(s.amount)}입니다.</p>
         <p><a href="${PARTNER_URL}">연장하기</a><br />
            <a href="${PARTNER_URL}">${PARTNER_URL}</a></p>
         <p>참고로 별도의 자동결제는 없으며, 연장하지 않으시면 ${on} 이후
            자동으로 노출이 종료됩니다.</p>
         <p>감사합니다.</p>`,
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
