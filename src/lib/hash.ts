import crypto from "node:crypto";

export const PATIENT_REGISTRATION_NUMBER_SALT =
  "d7d2f58f79e41d20a8a13f8a70a520586f58fa30bc083f753f4468768614d9c4"; //don't change this salt

export function hashRegistrationNumber(registrationNumber: string): string {
  return crypto
    .createHmac("sha256", PATIENT_REGISTRATION_NUMBER_SALT)
    .update(registrationNumber, "utf8")
    .digest("hex");
}

export function verifyRegistrationNumber(
  registrationNumber: string,
  hash: string,
): boolean {
  return hashRegistrationNumber(registrationNumber) === hash;
}
