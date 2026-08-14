/**
 * Kakao Local place lookup, shared by the app's facility search and by the
 * admin/partner profile forms.
 *
 * The forms need it because a clinic profile is keyed by Kakao place id, and
 * asking a clinic's staff to find and type that number is not a workable
 * onboarding step — they type it wrong, the save succeeds anyway, and nothing
 * ever shows up in the app with no indication why. Searching by name and
 * picking removes the whole class of problem, and fills in the phone and
 * address at the same time.
 */

const KAKAO_REST_KEY = process.env.KAKAO_REST_API_KEY ?? "";

export interface KakaoPlace {
  id: string;
  place_name: string;
  category_name: string;
  phone: string;
  address_name: string;
  road_address_name: string;
  x: string;
  y: string;
  place_url: string;
}

/** Kakao's own status, kept so callers can tell a bad key from a blocked IP. */
export class KakaoLookupError extends Error {
  constructor(readonly status: number) {
    super(`kakao ${status}`);
    this.name = "KakaoLookupError";
  }
}

export function hasKakaoKey(): boolean {
  return KAKAO_REST_KEY !== "";
}

/** Free-text place search, newest-relevance order as Kakao returns it. */
export async function searchPlaces(query: string, size = 10): Promise<KakaoPlace[]> {
  const params = new URLSearchParams({ query, size: String(size) });
  const resp = await fetch(
    `https://dapi.kakao.com/v2/local/search/keyword.json?${params.toString()}`,
    { headers: { Authorization: `KakaoAK ${KAKAO_REST_KEY}` } },
  );
  if (!resp.ok) throw new KakaoLookupError(resp.status);
  const data = (await resp.json()) as { documents?: KakaoPlace[] };
  return data.documents ?? [];
}

/**
 * "서울 강남구 대치동 889-11" → "서울 강남구 대치동".
 *
 * Lists show where a clinic is, not how to get there; the lot number is noise
 * at that size and pushes the useful part off the end of a single line.
 *
 * Cuts after the administrative unit (동/읍/면/가/리) rather than at a fixed
 * token count, because the number of tokens before it varies — Seoul has two
 * (시 구), a 시 with 구 inside a 도 has three.
 */
export function toDistrictAddress(address: string | null | undefined): string | null {
  if (!address) return null;
  const parts = address.trim().split(/\s+/);
  if (parts.length === 0) return null;
  const end = parts.findIndex((p) => /(동|읍|면|가|리)$/.test(p));
  if (end >= 0) return parts.slice(0, end + 1).join(" ");
  // A road-name address has no 동 at all; drop a trailing building number so
  // it at least stops at the street.
  const last = parts[parts.length - 1];
  return /^\d/.test(last) ? parts.slice(0, -1).join(" ") : parts.join(" ");
}

/**
 * Is this Kakao place an eye clinic?
 *
 * Kakao's keyword search matches anything — searching "서울" for a clinic
 * returns 청계천 and 경복궁. The profile form is only ever registering an eye
 * clinic, so places that aren't one are noise the user has to read past.
 *
 * Matches on the category, not the name: "밝은세상" is a clinic and "안과사거리"
 * is a road.
 */
export function isEyeClinic(categoryName: string): boolean {
  return (
    categoryName.includes("안과") ||
    categoryName.includes("대학병원") ||
    categoryName.includes("종합병원")
  );
}
