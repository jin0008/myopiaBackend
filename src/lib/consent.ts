// Current version of the consent documents the user agrees to.
// Bump this (and the on-screen document text) whenever the 이용약관 /
// 개인정보 수집·이용 / marketing wording changes, so user_consent /
// patient_consent rows record exactly which revision was agreed to.
// Format: the effective date of the document revision.
export const CONSENT_VERSION = "2026-06-10";

// 마이오닥 앱 약관·방침(myopiamanage.org/myodoc/tos, /myodoc/privacy)의 판본.
// 의료진 플랫폼과 user 테이블을 같이 쓰지만 문서는 따로라, 판본도 따로 센다.
// 같은 값을 쓰면 의료진 약관에 동의한 사람이 앱 약관에도 동의한 것으로 잡힌다.
// 두 문서 중 늦게 바뀐 날짜를 쓴다.
export const APP_CONSENT_VERSION = "app-2026-09-25";

/** 필수(약관·개인정보)는 true 로만 들어온다(zod.literal). 마케팅만 고른다. */
export function consentRows(version: string, agreeMarketing: boolean) {
  return [
    { consent_type: "terms_of_service" as const, version, agreed: true },
    { consent_type: "privacy_policy" as const, version, agreed: true },
    { consent_type: "marketing" as const, version, agreed: agreeMarketing },
  ];
}
