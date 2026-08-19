import type { ZodError } from "zod";

/**
 * Turn a Zod failure into something the person filling the form can act on.
 *
 * These endpoints answered every bad payload with `{"message":"invalid body"}`,
 * which tells an admin filling in a hospital profile nothing at all — the form
 * has thirty fields and any one of them could be the problem. Naming the field
 * turns a guessing game into a fix.
 *
 * Safe to return, including on the public signup route: a Zod message
 * describes the shape the caller's own request should have had ("password:
 * String must contain at least 8 character(s)"), never stored data or another
 * account's existence. Duplicate-email still answers 409 separately, so this
 * doesn't open an enumeration path.
 *
 * Keep it that way — if a schema ever validates against something secret, that
 * endpoint needs its own message rather than this one.
 */
export function validationMessage(error: ZodError): string {
  const issues = error.issues.slice(0, 3).map((i) => {
    const path = i.path.join(".");
    return path ? `${path}: ${i.message}` : i.message;
  });
  const more = error.issues.length - issues.length;
  return issues.join(", ") + (more > 0 ? ` 외 ${more}건` : "");
}

/**
 * 400 응답 본문. 사람이 읽을 문장과 함께, 어떤 필드가 왜 걸렸는지도 실어 보낸다.
 *
 * 문장만 보내면 클라이언트가 그걸 다시 파싱해야 어느 탭을 열어줄지 알 수 있다.
 * 필드 목록을 그대로 주면 화면이 자기 구조(탭·항목 이름)에 맞춰 옮겨 적을 수
 * 있다 — 어느 탭 어느 칸이 문제인지는 화면만 아는 정보다.
 */
export function validationBody(error: ZodError): {
  message: string;
  fields: { path: string; message: string }[];
} {
  return {
    message: validationMessage(error),
    fields: error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
  };
}
