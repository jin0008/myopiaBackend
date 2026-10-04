/**
 * 광고 자리 규칙.
 *
 * 앱이 광고를 고르는 쪽(mobile.ts)과 파트너에게 "자리가 찼다"고 알리는
 * 쪽(partner.ts)이 같은 수를 봐야 한다. 두 벌로 두면 자리를 5개로 늘린
 * 날 안내만 3개로 남아, 자리가 비었는데 기다리라고 하게 된다.
 */

/** 광고 자리 수. 한 지역에 프리미엄이 열 곳이면 첫 화면이 전부 광고가 된다. */
export const AD_SLOTS = 3;

/** 광고에는 검색 반경보다 좁은 자를 댄다. 반경 10km 를 그대로 쓰면 9km
 *  밖 업체가 맨 위에 붙어, 광고 자체를 믿지 않게 된다. */
export const AD_RADIUS_KM = 5;

/** 두 좌표 사이 거리(km). */
export function haversineKm(
  aLat: number,
  aLng: number,
  bLat: number,
  bLng: number,
): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
