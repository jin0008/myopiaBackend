/**
 * 이름으로 병원을 찾아 프로필 폼이 쓰는 모양으로 돌려준다.
 *
 * 같은 검색이 세 군데에서 쓰인다 - 운영자 등록(/hospital-profile/place-search),
 * 병원 담당자(/hospital-profile/mine/place-search), 파트너(/partner/place-search).
 * 전에는 세 곳에 같은 코드가 복사돼 있었고, 명부 폴백을 두 곳에만 넣는 바람에
 * 정작 쓰이는 파트너 화면에서는 고쳐지지 않았다. 한 군데서 만든다.
 */
import prisma from "./prisma";
import { KakaoLookupError, hasKakaoKey, searchEyeClinics } from "./kakaoPlaces";

/**
 * 카카오를 먼저 보고, 못 찾으면 우리 명부(심평원)로 떨어진다.
 *
 * 카카오맵에 있는 병원이라고 카카오 로컬 API 에도 있는 것은 아니다 -
 * 눈편한성모안과의원은 지도에 리뷰까지 달려 있는데 키워드 검색은 0건이다.
 * 색인이 다르다. 그동안은 이런 병원을 등록할 방법이 아예 없었다.
 *
 * 명부에서 온 것은 id 가 `hira:요양기호` 다. 프로필은 이 값을 그냥 열쇠로만
 * 쓰고(후기 조인) 카카오에 되묻지 않으므로 그대로 둬도 전 구간이 돈다.
 * 다만 컬럼 이름은 kakao_place_id 라, 언젠가 진짜 카카오 id 가 필요해지면
 * 출처를 따로 적어야 한다. */
export async function findPlaces(q: string) {
  // 카카오와 명부를 함께 본다.
  //
  // 전에는 "카카오가 0건일 때만" 명부로 떨어졌는데, 그래서는 신고된 버그가
  // 그대로 남는다 - "눈편한" 으로 찾으면 카카오가 눈편한안과를 돌려주므로
  // 0건이 아니고, 정작 찾던 눈편한성모안과의원(카카오 색인에 없다)은
  // 끝내 나오지 않는다. 둘 다 내놓고 고르게 한다.
  //
  // 카카오를 앞에 두는 이유는 그쪽 id 가 이 앱의 원래 열쇠이기 때문이다.
  // 같은 병원이 양쪽에 있으면 카카오 것을 남긴다.
  let docs: Awaited<ReturnType<typeof searchEyeClinics>> = [];
  if (hasKakaoKey()) {
    try {
      docs = await searchEyeClinics(q);
    } catch (err) {
      const status = err instanceof KakaoLookupError ? err.status : 0;
      console.error(`[place-search] kakao ${status} — 명부만으로 답한다`);
    }
  }

  const fromKakao = docs.map((d) => ({
    id: d.id,
    name: d.place_name,
    category: d.category_name,
    phone: d.phone || null,
    address: d.address_name || null,
    roadAddress: d.road_address_name || null,
    // 카카오는 x=경도, y=위도를 문자열로 준다. 여기서 숫자로 바꿔
    // 두지 않으면 등록 폼이 문자열을 그대로 보내 zod에 걸린다.
    latitude: Number.parseFloat(d.y),
    longitude: Number.parseFloat(d.x),
  }));

  const clinics = await prisma.eye_clinic.findMany({
    where: {
      closed_at: null,
      OR: [
        { name: { contains: q, mode: "insensitive" } },
        { address: { contains: q, mode: "insensitive" } },
      ],
    },
    select: { ykiho: true, name: true, address: true, phone: true, lat: true, lng: true },
    take: 10,
  });

  return mergePlaces(
    fromKakao,
    clinics.map((c) => ({
      id: `hira:${c.ykiho}`,
      name: c.name,
      category: "심평원 명부",
      phone: c.phone,
      address: c.address,
      roadAddress: c.address,
      latitude: c.lat,
      longitude: c.lng,
    })),
  );
}

/** 카카오 결과 뒤에 명부 결과를 붙이되, 같은 병원은 한 번만 낸다.
 *
 *  같은 곳이 두 줄로 나오면 운영자가 어느 쪽을 골라야 할지 알 수 없다.
 *  상호는 "눈편한 성모안과" 와 "눈편한성모안과" 처럼 띄어쓰기가 갈리므로
 *  공백을 지우고 견준다. */
export function mergePlaces<T extends { name: string; phone?: string | null }>(
  fromKakao: T[],
  fromDirectory: T[],
): T[] {
  // 상호는 "눈편한 성모안과"/"눈편한성모안과" 처럼 띄어쓰기가 갈리고,
  // 카카오는 "눈편한안과" 인데 명부는 "눈편한안과의원" 처럼 법인 꼬리표가
  // 붙고 빠진다. 이름만으로는 같은 곳을 알아보지 못한다.
  const squash = (v: string) => v.replace(/\s+/g, "");
  // 꼬리표를 떼고 견준다. 의원/병원은 상호의 일부가 아니라 종별 표기다.
  const bare = (v: string) => squash(v).replace(/(의원|병원)$/, "");
  const digits = (v: string | null | undefined) => (v ?? "").replace(/\D/g, "");

  const names = new Set(fromKakao.map((p) => bare(p.name)));
  // 전화가 같으면 같은 곳으로 본다 - 이름이 아무리 달라도 그렇다.
  // 빈 전화는 열쇠가 되지 못하므로 넣지 않는다.
  const phones = new Set(fromKakao.map((p) => digits(p.phone)).filter((d) => d !== ""));

  return [
    ...fromKakao,
    ...fromDirectory.filter(
      (c) => !names.has(bare(c.name)) && !phones.has(digits(c.phone)),
    ),
  ];
}

