/**
 * 광고 값.
 *
 * 결제가 금액을 정하지만(payment.ts), 파트너 화면도 "얼마인가"를 보여야
 * 한다. 화면에 숫자를 적어 두면 가격을 올린 날 결제창과 안내가 어긋나
 * 업체가 본 값과 빠지는 값이 달라진다. 한 곳에 두고 둘이 읽는다.
 */

/**
 * 한 달 값(원). 행정동 하나를 한 달 독점하는 값이다.
 *
 * 기본값을 두지 않는다. 어느 쪽으로 틀려도 돈 사고다 - 10만원을 적어 두면
 * 설정을 잊은 서버가 진짜로 10만원을 긁고, 100원을 적어 두면 10만원짜리
 * 상품이 100원에 나간다. 설정이 없으면 팔지 않는다(isPriced).
 */
export const MONTHLY_AMOUNT = Number(process.env.SUBSCRIPTION_MONTHLY_AMOUNT ?? 0);

/** 값이 설정되었나. 아니면 결제창을 열지 않는다. */
export function isPriced(): boolean {
  return Number.isFinite(MONTHLY_AMOUNT) && MONTHLY_AMOUNT > 0;
}

/** 결제창과 영수증에 나가는 상품 이름. */
export const GOODS_NAME = "마이오닥 독점 노출";
