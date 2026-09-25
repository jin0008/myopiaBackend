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

/** 카카오 분류 갈래 코드. HP8 = 병원. */
const HOSPITAL_GROUP = "HP8";

export function hasKakaoKey(): boolean {
  return KAKAO_REST_KEY !== "";
}

/**
 * Free-text place search, newest-relevance order as Kakao returns it.
 *
 * categoryGroupCode 를 주면 그 갈래만 받는다. "HP8" 은 병원이다 - 병원을
 * 찾는 자리에서 학교·장례식장이 앞자리를 차지하지 않게 한다.
 */
export async function searchPlaces(
  query: string,
  size = 10,
  categoryGroupCode?: string,
): Promise<KakaoPlace[]> {
  const params = new URLSearchParams({ query, size: String(size) });
  if (categoryGroupCode) params.set("category_group_code", categoryGroupCode);
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
 * 두 번 찾아서 합친다. 물어본 말 그대로 한 번, "안과"를 붙여 한 번.
 *
 * 붙이는 이유는 "밝은세상"처럼 이름만으로는 안과인지 알 수 없는 검색어
 * 때문이다. 카카오 키워드 검색은 아무거나 잡아서, "서울"로 찾으면 청계천과
 * 경복궁이 나온다.
 *
 * 그대로도 찾는 이유는 "중앙대"처럼 병원 이름의 일부를 치는 경우다. 붙인
 * 쪽은 중앙대 둘레의 안과의원들을 잔뜩 물어 오고 정작 중앙대학교병원은
 * 이름에 안과가 없어 끝내 안 나온다. 결과가 0건일 때만 다시 찾게 해 봤더니
 * 0건이 아니라서 걸리지 않았다 - 없는 게 아니라 다른 것이 채워져 있었다.
 *
 * 그대로 찾은 것을 앞에 둔다. 사용자가 친 말에 가장 가까운 것이 그쪽이다.
 *
 * 둘 다 병원(HP8)만 받는다. 그러지 않으면 "중앙대" 로 찾을 때 상위 자리를
 * 중앙대학교 서울캠퍼스·다빈치캠퍼스·후문·장례식장이 채워, 정작 찾는
 * 중앙대학교광명병원이 열다섯 개 안에 못 든다.
 *
 * 분류로 의료기관만 남긴다. "안과사거리"는 길이고 "밝은세상"은 병원이라,
 * 이름이 아니라 분류를 본다. 다 걸러지면 거르지 않은 것을 낸다 - 이 검색은
 * 병원이 자기를 등록하는 자리라, 카카오가 모르는 분류로 넣어 둔 병원이
 * 등록 자체를 못 하게 되면 안 된다. 시끄러운 목록은 되돌릴 수 있지만 빈
 * 목록은 막다른 길이다.
 */
export async function searchEyeClinics(query: string, limit = 10): Promise<KakaoPlace[]> {
  const [asIs, narrowed] = await Promise.all([
    searchPlaces(query, 15, HOSPITAL_GROUP),
    query.includes("안과")
      ? Promise.resolve([] as KakaoPlace[])
      : searchPlaces(`${query} 안과`, 15, HOSPITAL_GROUP),
  ]);

  const seen = new Set<string>();
  const merged: KakaoPlace[] = [];
  for (const d of [...asIs, ...narrowed]) {
    if (seen.has(d.id)) continue;
    seen.add(d.id);
    merged.push(d);
  }

  return rankEyeClinics(merged, limit);
}

/**
 * 안과로 분류된 곳을 앞에 두되, 나머지를 버리지는 않는다.
 *
 * 전에는 안과가 하나라도 걸리면 나머지를 통째로 버렸다. 그런데 카카오가
 * 안과를 늘 "안과"로 분류하지는 않는다 - 눈편한성모안과의원은 "일반의원"
 * 이다. "눈편한"으로 찾으면 눈편한안과 같은 진짜 안과가 함께 걸리므로,
 * 버리는 쪽 규칙에서는 이런 병원이 영원히 보이지 않았다.
 */
export function rankEyeClinics<T extends { category_name: string }>(
  docs: T[],
  limit: number,
): T[] {
  const clinics = docs.filter((d) => isEyeClinic(d.category_name));
  const others = docs.filter((d) => !isEyeClinic(d.category_name));
  return [...clinics, ...others].slice(0, limit);
}
