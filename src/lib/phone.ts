/**
 * 전화번호를 한 가지 모양으로.
 *
 * 공공 자료의 번호는 제각각이다 - "02-123-4567" 도 있고 "34425050" 처럼
 * 지역번호 없이 숫자만 있는 것도 있다. 목록에 섞여 나오면 어느 것이 전화를
 * 걸 수 있는 번호인지 알기 어렵다.
 *
 * 지역번호를 붙일 때는 확신이 설 때만 붙인다. 틀린 번호를 만들어 내면
 * 안 고치느니만 못하다 - 부모가 엉뚱한 곳에 전화한다.
 */

/** 시/군 단위로 정해져 있다. 경기와 광주·전남이 갈리는 곳만 예외로 둔다. */
const AREA_BY_SIDO: Record<string, string> = {
  서울: "02",
  부산: "051",
  대구: "053",
  인천: "032",
  대전: "042",
  울산: "052",
  세종: "044",
  경기: "031",
  강원: "033",
  충북: "043",
  충남: "041",
  전북: "063",
  전남: "061",
  경북: "054",
  경남: "055",
  제주: "064",
};

/** 같은 도 안에서 지역번호가 다른 곳. */
const AREA_EXCEPTIONS: { sido: string; sigungu: RegExp; area: string }[] = [
  // 광명·과천은 서울 번호를 쓴다.
  { sido: "경기", sigungu: /^(광명|과천)/, area: "02" },
  // 부천·김포는 인천 번호를 쓴다.
  { sido: "경기", sigungu: /^(부천|김포)/, area: "032" },
];

/** 자료의 시도 값이 "전남광주" 로 뭉쳐 있다. 광주 자치구면 062, 아니면 061. */
const GWANGJU_GU = /^(동구|서구|남구|북구|광산구)/;

export function areaCodeFor(sido: string, sigungu: string): string | null {
  const s = (sido ?? "").trim();
  const g = (sigungu ?? "").trim();
  for (const e of AREA_EXCEPTIONS) {
    if (s === e.sido && e.sigungu.test(g)) return e.area;
  }
  if (s === "전남광주") return GWANGJU_GU.test(g) ? "062" : "061";
  return AREA_BY_SIDO[s] ?? null;
}

/** 국번 없이 전국에서 걸리는 번호. 1588-1234 처럼 넷-넷으로 끊는다. */
const NATIONWIDE = /^(1[5-9]\d{2})(\d{4})$/;

/**
 * @param raw   자료에 적힌 번호
 * @param area  지역번호가 빠졌을 때 붙일 것. 모르면 null - 그때는 손대지 않는다.
 */
export function normalizePhone(raw: string | null, area: string | null): string | null {
  if (raw == null) return null;
  // "033-647-6166~7" 처럼 뒤에 다른 번호를 덧붙여 적은 것이 있다. 첫 번호만.
  const head = raw.split(/[~,/]/)[0].trim();
  if (head === "") return null;

  const digits = head.replace(/\D/g, "");
  if (digits === "") return null;

  const nation = NATIONWIDE.exec(digits);
  if (nation) return `${nation[1]}-${nation[2]}`;

  // 인터넷전화(070)와 안심번호(0503·0507 등)는 지역번호가 아니다. 네 자리를
  // 앞머리로 끊는다 - 세 자리로 보면 여기에 지역번호를 또 붙여 아예 다른
  // 번호가 만들어진다(070-4702-2500 → 031-0704-7022500).
  if (/^050\d/.test(digits)) return split(digits, 4);
  if (digits.startsWith("070")) return split(digits, 3);

  // 지역번호가 이미 있는 경우.
  if (digits.startsWith("02")) return split(digits, 2);
  if (/^0(1[016-9]|[3-6]\d)/.test(digits)) return split(digits, 3);

  // 0 으로 시작하면 이미 완성된 번호로 본다. 아는 지역번호가 아니어도
  // (자료에 074-139-3162 같은 것이 있다) 앞에 무언가를 더 붙이면 아예 다른
  // 번호가 된다. 모양이 이상한 채로 두는 편이 낫다.
  if (digits.startsWith("0")) return head;

  // 지역번호 없이 국번만 적힌 경우. 붙일 것을 모르면 그대로 둔다 -
  // 지어내면 엉뚱한 곳으로 전화가 간다.
  if (area == null) return head;
  return split(area.replace(/\D/g, "") + digits, area.length);
}

/** 지역번호 뒤를 국번과 가입자번호로 끊는다. 국번은 3자리이거나 4자리다. */
function split(digits: string, areaLen: number): string {
  const area = digits.slice(0, areaLen);
  const rest = digits.slice(areaLen);
  if (rest.length < 7) return digits; // 모양을 모르겠으면 건드리지 않는다
  const mid = rest.length >= 8 ? 4 : 3;
  return `${area}-${rest.slice(0, mid)}-${rest.slice(mid)}`;
}
