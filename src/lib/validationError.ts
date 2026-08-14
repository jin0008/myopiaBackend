import type { ZodError } from "zod";

/**
 * Turn a Zod failure into something the person filling the form can act on.
 *
 * These endpoints answered every bad payload with `{"message":"invalid body"}`,
 * which tells an admin filling in a hospital profile nothing at all — the form
 * has thirty fields and any one of them could be the problem. Naming the field
 * turns a guessing game into a fix.
 *
 * Safe to return: these are our own admin/partner surfaces, and the message
 * describes the request the caller just sent, not anything they can't see.
 */
export function validationMessage(error: ZodError): string {
  const issues = error.issues.slice(0, 3).map((i) => {
    const path = i.path.join(".");
    return path ? `${path}: ${i.message}` : i.message;
  });
  const more = error.issues.length - issues.length;
  return issues.join(", ") + (more > 0 ? ` 외 ${more}건` : "");
}
