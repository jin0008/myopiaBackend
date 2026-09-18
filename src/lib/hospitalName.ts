/**
 * 병원 이름 두 칸.
 *
 * - `name`    : 가입 때 입력한 원래 이름. 영문일 수도, 한글일 수도 있다. 필수·유일.
 * - `name_ko` : 한글 표시 이름. 선택. 비어 있으면(NULL) `name` 을 그대로 쓴다.
 *
 * 처음부터 한글로 가입한 병원은 `name` 이 이미 한글이므로 `name_ko` 를
 * 비워 둔다. 같은 값을 두 칸에 넣으면 한쪽만 고쳐지는 일이 생긴다.
 */
export type HospitalNames = { name: string; name_ko?: string | null };

/** 화면·앱·메일에 보일 이름: 한글 이름이 있으면 그것, 없으면 원래 이름. */
export function hospitalDisplayName(h: HospitalNames): string {
  const ko = h.name_ko?.trim();
  return ko ? ko : h.name;
}

/**
 * 입력받은 한글 이름을 저장할 값으로 바꾼다. 공백뿐이거나 비어 있으면 NULL.
 * 원래 이름과 똑같으면 따로 둘 이유가 없으므로 역시 NULL.
 */
export function normalizeNameKo(
  value: string | null | undefined,
  originalName?: string,
): string | null {
  const v = value?.trim();
  if (!v) return null;
  if (originalName != null && v === originalName.trim()) return null;
  return v;
}

/** 표시 이름 기준 가나다(ABC) 순. */
export function compareHospitalNames(a: HospitalNames, b: HospitalNames) {
  return hospitalDisplayName(a).localeCompare(hospitalDisplayName(b), "ko");
}
