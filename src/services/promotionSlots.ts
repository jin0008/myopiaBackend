/**
 * 내 가게 둘레에 남의 광고가 몇 개 걸려 있나.
 *
 * 세 곳이 같은 답을 봐야 한다 - 파트너에게 "자리가 찼다"고 알리는 쪽,
 * 독점을 결제하려는 쪽, 운영자가 독점으로 승인하는 쪽. 두 벌로 두면
 * 자리가 있다고 안내받은 업체가 결제에서 막히거나, 더 나쁘게는 같은
 * 반경에 독점이 두 곳 팔린다.
 */

import prisma from "../lib/prisma";
import { coordToRegion, hasKakaoKey, type KakaoRegion } from "../lib/kakaoPlaces";

/** 계정에 묶인 가게와 그 좌표. 묶이지 않았거나 명부에서 사라졌으면 null. */
export async function linkedFacility(
  accountId: string,
): Promise<{ kind: "eye" | "optical"; key: string; lat: number; lng: number } | null> {
  const account = await prisma.hospital_account.findUnique({
    where: { id: accountId },
    select: { facility_kind: true, facility_key: true },
  });
  const kind = account?.facility_kind;
  const key = account?.facility_key;
  if (kind == null || key == null) return null;
  return at(kind === "eye" ? "eye" : "optical", key);
}

/** 업종과 번호로 명부에서 좌표를 찾는다. */
export async function at(
  kind: "eye" | "optical",
  key: string,
): Promise<{ kind: "eye" | "optical"; key: string; lat: number; lng: number } | null> {
  const row =
    kind === "eye"
      ? await prisma.eye_clinic.findUnique({
          where: { ykiho: key },
          select: { lat: true, lng: true },
        })
      : await prisma.optical_shop.findUnique({
          where: { license_no: key },
          select: { lat: true, lng: true },
        });
  return row == null ? null : { kind, key, lat: row.lat, lng: row.lng };
}

/**
 * 독점은 행정동 하나에 하나씩이다.
 *
 * 반경으로 재지 않는다. 5km 반경은 서울에서 거의 구 단위라, 한 곳을 팔면
 * 수십 곳이 잠겨 팔 자리가 남지 않았다. 광고를 사는 쪽이 말하는 "우리 동네"도
 * 반경이 아니라 동이다.
 *
 * 상품은 하나다. 살아 있는 광고가 곧 그 동의 주인이라, 등급을 가려 세지
 * 않는다.
 */
export class RegionUnknown extends Error {}

/** 좌표의 행정동. 카카오가 답하지 않으면 RegionUnknown 을 던진다. */
export async function regionOf(lat: number, lng: number): Promise<KakaoRegion> {
  if (!hasKakaoKey()) throw new RegionUnknown();
  let region: KakaoRegion | null;
  try {
    region = await coordToRegion(lat, lng);
  } catch {
    throw new RegionUnknown();
  }
  // 동을 모르면 독점을 팔지 않는다. 모르는 채로 팔면 같은 동에 둘을 걸 수
  // 있고, 그것은 환불로도 되돌릴 수 없다.
  if (region == null) throw new RegionUnknown();
  return region;
}

/**
 * 이 동에 살아 있는 남의 광고. 먼저 끝나는 것이 앞이다.
 *
 * 동을 모르는 광고(지난 마이그레이션 전에 걸린 것)는 그 자리에서 채운다.
 * 살아 있는 독점은 많아야 수십 건이고, 한 번 채우면 다시 묻지 않는다.
 */
export async function adsInRegion(
  kind: "eye" | "optical",
  regionCode: string,
  exceptKey: string,
): Promise<{ key: string; endsAt: Date }[]> {
  const now = new Date();

  // 동이 적힌 것은 DB 가 걸러 준다. 인덱스가 받는 질의다.
  const known = await prisma.facility_promotion.findMany({
    where: {
      kind,
      region_code: regionCode,
      starts_at: { lte: now },
      ends_at: { gte: now },
      key: { not: exceptKey },
    },
    select: { key: true, ends_at: true },
  });

  // 동이 비어 있는 것만 따로 채운다. 마이그레이션 전에 걸린 광고들이고,
  // 한 번 채우면 다시 묻지 않는다.
  const unknown = await prisma.facility_promotion.findMany({
    where: {
      kind,
      region_code: null,
      starts_at: { lte: now },
      ends_at: { gte: now },
      key: { not: exceptKey },
    },
    select: { id: true, key: true, ends_at: true },
  });

  const filled: { key: string; endsAt: Date }[] = [];
  for (const p of unknown) {
    const place = await at(kind, p.key);
    // 명부에서 사라진 곳은 동을 알 수 없다. 폐업 등으로 빠진 광고라 자리를
    // 차지한다고 보지 않는다.
    if (place == null) continue;
    const region = await regionOf(place.lat, place.lng);
    // updateMany 를 쓴다. 그 사이 지워진 행이면 update 는 P2025 로 터지는데,
    // 여기는 자리를 묻기만 하는 길이라 남의 행 하나 때문에 500 이 날 자리가
    // 아니다. 같은 동이 이미 차 있으면 유니크에 걸리므로 그것도 삼킨다 -
    // 채우지 못했을 뿐, 아래 판정은 region.code 로 그대로 한다.
    await prisma.facility_promotion
      .updateMany({
        where: { id: p.id },
        data: { region_code: region.code, region_name: region.name },
      })
      .catch(() => undefined);
    if (region.code === regionCode) filled.push({ key: p.key, endsAt: p.ends_at });
  }

  return [...known.map((p) => ({ key: p.key, endsAt: p.ends_at })), ...filled].sort(
    (a, b) => a.endsAt.getTime() - b.endsAt.getTime(),
  );
}
