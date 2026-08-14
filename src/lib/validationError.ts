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
