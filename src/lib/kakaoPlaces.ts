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
  // 도로명 주소에는 동이 없다. 이때 번지만 떼면 "서울 강남구 테헤란로"가 되어
  // 목록에 길 이름이 남는데, 목록에서 알고 싶은 건 길이 아니라 어느 동네인지다.
  // 시/군/구까지만 남긴다.
  // 첫 토큰은 시/도(서울, 경기)라 접미사가 없다. 그 뒤로 시·군·구가 이어지는
  // 만큼 붙인다 - "경기 성남시 분당구"처럼 시 안에 구가 있는 곳이 있어서
  // 처음 만나는 하나만 취하면 "경기 성남시"에서 잘린다.
  let end2 = 1;
  while (end2 < parts.length && /(시|군|구)$/.test(parts[end2])) end2 += 1;
  if (end2 > 1) return parts.slice(0, end2).join(" ");
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

/**
 * Place search for the profile forms, narrowed to eye clinics.
 *
 * "안과" is appended to the query so Kakao ranks clinics first, and the
 * category filter removes whatever still isn't one. Over-fetches because the
 * filter drops rows.
 *
 * If the filter empties the list, the unfiltered results are returned instead:
 * this search exists so a clinic can register itself, and a clinic that Kakao
 * files under a category we don't recognise must not become unregisterable.
 * A noisy list is recoverable; an empty one is a dead end.
 */
export async function searchEyeClinics(query: string, limit = 10): Promise<KakaoPlace[]> {
  const docs = await searchPlaces(query.includes("안과") ? query : `${query} 안과`, 15);
  const clinics = docs.filter((d) => isEyeClinic(d.category_name));
  return (clinics.length > 0 ? clinics : docs).slice(0, limit);
}
