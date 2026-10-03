/**
 * 광고 기간 계산.
 *
 * 운영자가 신청을 승인할 때와 파트너가 결제할 때, 둘 다 같은 규칙으로
 * 기간을 잡아야 한다. 두 벌로 두면 한쪽만 고쳐져 "승인으로 받은 한 달"과
 * "결제로 받은 한 달"의 길이가 달라진다.
 */

/** 하루의 시작과 끝을 KST 로 잡는다. 업체가 말하는 "9월 1일부터"는
 *  한국 시각 9월 1일 0시다. */
export function kstDayStart(day: string): Date {
  return new Date(`${day}T00:00:00+09:00`);
}
export function kstDayEnd(day: string): Date {
  return new Date(`${day}T23:59:59+09:00`);
}

/** 그 달의 마지막 날. */
function daysInMonth(year: number, month0: number): number {
  return new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();
}

/**
 * 시작일에 개월 수를 더한 마지막 날(KST).
 *
 * 달력 계산은 정수로 한다. Date 의 setMonth/getDate 는 서버의 지역 시각을
 * 따르는데, 서버가 한국 시각이라는 보장이 없어 하루씩 밀린다.
 *
 * 도착한 달에 그 날짜가 없으면 그 달의 말일까지다(민법 제160조). 1/31 에
 * 한 달을 더하면 2/31 은 없으니 2/28 까지이고, 거기서 하루를 더 빼면
 * 안 된다 - 2월에 신청한 업체만 하루를 손해 본다.
 */
export function endOfTerm(startsOn: string, months: number): Date {
  const [y, m, d] = startsOn.split("-").map(Number);
  const targetMonth0 = m - 1 + months;
  const ty = y + Math.floor(targetMonth0 / 12);
  const tm0 = ((targetMonth0 % 12) + 12) % 12;
  const dim = daysInMonth(ty, tm0);
  // 같은 날짜가 있으면 그 전날까지가 한 달이다(9/1 시작 1개월 → 9/30).
  // 없으면 그 달의 말일까지다(1/31 시작 1개월 → 2/28).
  const end =
    d > dim ? new Date(Date.UTC(ty, tm0, dim)) : new Date(Date.UTC(ty, tm0, d - 1));
  const yy = end.getUTCFullYear();
  const mm = String(end.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(end.getUTCDate()).padStart(2, "0");
  return kstDayEnd(`${yy}-${mm}-${dd}`);
}

/**
 * 이어 붙일 때의 새 종료일.
 *
 * 남아 있는 기간의 다음 날부터 개월 수를 달력으로 센다. 밀리초로 더하면
 * 2월에 이어 붙인 "한 달"이 28일이 되고 7월에 이어 붙이면 31일이 된다 -
 * 업체가 산 것은 한 달이지 며칠이 아니다.
 */
export function extendTerm(currentEnd: Date, months: number): Date {
  // 종료 시각은 KST 23:59:59 다. 9시간을 더해 읽으면 그 날짜가 나온다.
  const kst = new Date(currentEnd.getTime() + 9 * 3600 * 1000);
  const next = new Date(
    Date.UTC(kst.getUTCFullYear(), kst.getUTCMonth(), kst.getUTCDate() + 1),
  );
  return endOfTerm(next.toISOString().slice(0, 10), months);
}

/** 오늘(KST) 을 YYYY-MM-DD 로. */
export function kstTodayString(): string {
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}
