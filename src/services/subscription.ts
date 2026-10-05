/**
 * 구독과 광고 기간.
 *
 * 결제창으로 한 번 내는 길과 빌링키로 매달 빠지는 길이 같은 함수를 쓴다.
 * 두 벌로 두면 한쪽만 고쳐져 "직접 낸 한 달"과 "자동으로 빠진 한 달"의
 * 길이가 달라진다.
 */

import { Prisma } from "@prisma/client";

import prisma from "../lib/prisma";
import { at, regionOf } from "./promotionSlots";
import {
  endOfTerm,
  extendTerm,
  kstDayStart,
  kstTodayString,
} from "../lib/promotionTerm";

/**
 * 돈이 들어왔으니 구독을 민다.
 *
 * 끝나는 날부터 더한다. 오늘부터 더하면 일찍 낸 사람이 남은 날을 잃는다.
 */
export async function extendSubscription(
  accountId: string,
  paymentId: string,
  amount: number,
  months: number,
): Promise<void> {
  const now = new Date();
  const sub = await prisma.subscription.findUnique({ where: { account_id: accountId } });
  const from = sub != null && sub.current_period_end > now ? sub.current_period_end : now;
  const next = new Date(from);
  // 산 개월 수만큼. 한 달로 고정하면 석 달치를 낸 사람이 한 달만 받는다.
  next.setMonth(next.getMonth() + months);

  // 한 달치로 적는다. 낸 돈을 그대로 넣으면 6개월치를 산 업체가 "한 달
  // 600원"으로 기록되고, 만료 안내 메일이 그 값을 그대로 읽는다.
  const monthly = Math.round(amount / months);

  const saved =
    sub == null
      ? await prisma.subscription.create({
          data: {
            account_id: accountId,
            status: "active",
            current_period_end: next,
            amount: monthly,
          },
        })
      : await prisma.subscription.update({
          where: { id: sub.id },
          data: {
            status: "active",
            current_period_end: next,
            amount: monthly,
            canceled_at: null,
            updated_at: new Date(),
          },
        });
  await prisma.payment.update({
    where: { id: paymentId },
    data: { subscription_id: saved.id },
  });

  await startPromotion(accountId, months);
}

/**
 * 돈을 받았으니 광고를 건다.
 *
 * 운영자 승인을 거치지 않는다. 업체 인증에서 서류를 보고 사람이 한 번
 * 확인했고, 거기 돈까지 붙었다. 한 번 더 보게 하면 파트너는 돈을 내고
 * 기다리게 된다.
 *
 * 운영자가 손으로 거는 길은 그대로 남는다 - 무료 제휴나 보상처럼 돈
 * 없이 걸어 주는 경우다.
 *
 * 기간 계산은 승인 경로와 같은 함수를 쓴다. 두 벌로 두면 "승인으로 받은
 * 한 달"과 "결제로 받은 한 달"의 길이가 달라진다.
 */
async function startPromotion(accountId: string, months: number): Promise<void> {
  const account = await prisma.hospital_account.findUnique({
    where: { id: accountId },
    select: { facility_kind: true, facility_key: true },
  });
  if (account?.facility_kind == null || account.facility_key == null) {
    // checkout 에서 막아 두었으니 여기까지 오면 그 사이에 운영자가 연결을
    // 푼 것이다. 돈은 받았으므로 실패로 두지 않고 남겨만 둔다.
    console.error("[payment] 업체가 묶이지 않은 계정의 결제", accountId);
    return;
  }
  const kind = account.facility_kind;
  const key = account.facility_key;
  const today = kstTodayString();
  const startsAt = kstDayStart(today);

  // 어느 동인지 적어 둔다. 이것이 곧 독점 구역이라, 다음 업체가 같은 동을
  // 사려 할 때 이 값으로 막는다.
  //
  // 실패하면 비워 둔 채 넘어간다. 여기는 돈이 이미 빠진 자리라 카카오가
  // 답하지 않는다고 광고를 걸지 않을 수는 없다 - 비어 있으면 다음 판정
  // 때 그 자리에서 채운다(promotionSlots.exclusivesInRegion).
  let region: { code: string; name: string } | null = null;
  const place = await at(kind === "eye" ? "eye" : "optical", key);
  if (place != null) {
    try {
      region = await regionOf(place.lat, place.lng);
    } catch {
      console.error("[payment] 광고의 행정동을 알아내지 못했다", kind, key);
    }
  }

  // 이미 광고가 걸린 곳이면 기간을 이어 붙인다. 덮어쓰면 남은 기간이
  // 사라져 돈을 낸 만큼 나가지 않는다.
  //
  // 반대로 지난 광고가 남아 있는 곳이면 시작일도 함께 새로 잡는다.
  // 끝나는 날만 미루면 옛 시작일이 그대로 남아, 광고가 없던 사이 기간까지
  // 살아 있는 것으로 계산된다 - 돈을 안 받은 달에 광고가 나간다.
  const existing = await prisma.facility_promotion.findUnique({
    where: { kind_key: { kind, key } },
  });
  const stillRunning = existing != null && existing.ends_at > startsAt;

  // 같은 동에 이미 주인이 있으면 걸지 않는다.
  //
  // /checkout 이 결제 전에 한 번 보지만 그것만으로는 못 막는다 - 두 업체가
  // 같은 때에 결제를 끝내면 둘 다 "비어 있다"를 보고 지나간다. 마지막 자는
  // DB 의 유니크(kind, region_code)이고, 걸리면 P2002 로 온다.
  //
  // 걸렸을 때 터뜨리지 않는다. 여기는 돈이 이미 빠진 자리라, 예외를 던지면
  // 결제 쪽이 실패로 적고 업체는 돈만 낸 채 아무 말도 못 듣는다. 광고 없이
  // 남기고 크게 적어 둔다 - 사람이 보고 환불하거나 다른 동을 권해야 한다.
  try {
    await prisma.facility_promotion.upsert({
      where: { kind_key: { kind, key } },
      create: {
        kind,
        key,
        region_code: region?.code ?? null,
        region_name: region?.name ?? null,
        starts_at: startsAt,
        ends_at: endOfTerm(today, months),
        account_id: accountId,
        note: "구독 결제",
      },
      update: {
        // 동을 새로 알아냈으면 적고, 못 알아냈으면 전에 적힌 것을 지우지
        // 않는다. 지우면 그 자리에 다른 광고가 팔릴 수 있다.
        ...(region == null ? {} : { region_code: region.code, region_name: region.name }),
        starts_at: stillRunning ? existing!.starts_at : startsAt,
        ends_at: stillRunning
          ? extendTerm(existing!.ends_at, months)
          : endOfTerm(today, months),
        account_id: accountId,
        updated_at: new Date(),
      },
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      console.error(
        "[payment] 같은 동에 이미 광고가 있어 걸지 못했다 - 환불이나 안내가 필요하다",
        { accountId, kind, key, region: region?.name ?? null },
      );
      return;
    }
    throw e;
  }
}
