/**
 * 광고 자리 규칙.
 *
 * 앱이 광고를 고르는 쪽(mobile.ts)과 파트너에게 "자리가 찼다"고 알리는
 * 쪽(partner.ts)이 같은 수를 봐야 한다. 두 벌로 두면 자리를 5개로 늘린
 * 날 안내만 3개로 남아, 자리가 비었는데 기다리라고 하게 된다.
 */

/**
 * 광고 자리 수.
 *
 * 하나다. 광고는 행정동 하나에 한 곳만 판다 - 자리를 여럿 두면 "이 동네에선
 * 나만 크게 뜬다"는 말이 거짓이 되고, 그 말이 이 상품의 전부다.
 *
 * 사용자 둘레 5km 에는 여러 동이 들어오므로 후보가 여럿일 수 있다. 그때는
 * 가장 가까운 한 곳이 자리를 가져간다 - 검색할 때마다 사용자 좌표의 동을
 * 카카오에 되묻는 것보다 싸고, 보통 그쪽이 사용자가 서 있는 동의 광고주다.
 */
export const AD_SLOTS = 1;

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

/**
 * 자가 점검.
 *
 *   npx ts-node src/lib/adSlots.ts
 *
 * 독점 자리는 돈이 걸린 판정이라 한 번은 돌려 봐야 한다. 등급별 자리 수나
 * 반경 자가 틀어지면 같은 동네에 독점이 둘 팔린다.
 */
if (require.main === module) {
  const assert: typeof import("assert") = require("assert");

  // 자리는 하나다. 늘리면 같은 동에 둘이 서고 독점이 아니게 된다.
  assert.strictEqual(AD_SLOTS, 1);

  // 거리 계산은 광고 반경을 재는 자다. 서울시청에서 약 0.6km 지점.
  assert.ok(Math.abs(haversineKm(37.5663, 126.9779, 37.5703, 126.9829) - 0.6) < 0.1);

  console.log("adSlots ok");
}
