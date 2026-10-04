/**
 * 자리가 찼는지 가늠하는 규칙.
 *
 *   npx tsx scripts/check-ad-slots.ts
 */
import assert from "assert";

import { AD_RADIUS_KM, AD_SLOTS, haversineKm } from "../src/lib/adSlots";

/** 서울시청 ↔ 강남역은 5km 를 넘는다. 같은 서울이라고 한 자리를
 *  다투는 것이 아니다. */
const cityHall = { lat: 37.5663, lng: 126.9779 };
const gangnam = { lat: 37.4979, lng: 127.0276 };
assert.ok(
  haversineKm(cityHall.lat, cityHall.lng, gangnam.lat, gangnam.lng) > AD_RADIUS_KM,
  "시청과 강남역은 광고 반경 밖이다",
);
// 광화문은 시청에서 1km 안쪽이다.
assert.ok(
  haversineKm(cityHall.lat, cityHall.lng, 37.5759, 126.9769) < AD_RADIUS_KM,
  "광화문은 시청과 같은 자리를 다툰다",
);

/**
 * 자리가 찼는지와, 다음에 빌 날.
 *
 * 같은 업종만 센다 - 사용자가 안과를 보고 있으면 안경원 광고는 그 자리를
 * 차지하지 않는다.
 */
function availability(
  mine: { kind: string },
  near: { kind: string; endsOn: string }[],
): { full: boolean; nextFreeOn: string | null } {
  const same = near
    .filter((p) => p.kind === mine.kind)
    .sort((a, b) => a.endsOn.localeCompare(b.endsOn));
  const full = same.length >= AD_SLOTS;
  return { full, nextFreeOn: full ? same[0].endsOn : null };
}

assert.deepStrictEqual(
  availability({ kind: "optical" }, [
    { kind: "optical", endsOn: "2026-11-30" },
    { kind: "optical", endsOn: "2026-11-03" },
    { kind: "optical", endsOn: "2026-12-15" },
  ]),
  { full: true, nextFreeOn: "2026-11-03" },
  "찼으면 가장 먼저 끝나는 날을 알린다",
);

assert.deepStrictEqual(
  availability({ kind: "optical" }, [
    { kind: "optical", endsOn: "2026-11-30" },
    { kind: "eye", endsOn: "2026-11-03" },
    { kind: "eye", endsOn: "2026-12-15" },
  ]),
  { full: false, nextFreeOn: null },
  "안과 광고는 안경원 자리를 차지하지 않는다",
);

assert.deepStrictEqual(
  availability({ kind: "eye" }, []),
  { full: false, nextFreeOn: null },
  "둘레에 아무도 없으면 비어 있다",
);

console.log("ok — 같은 업종만, 반경 안만 세고, 찼으면 다음 빌 날을 알린다");
