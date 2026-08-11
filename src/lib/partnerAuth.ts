import jwt, { SignOptions } from "jsonwebtoken";
import { RequestHandler } from "express";

/**
 * Auth for hospital partner accounts (the self-service finder portal). Kept
 * separate from patient (mobileAuth) and doctor (session) auth. Reuses the
 * same JWT secret as the mobile app but stamps `kind: "partner"` so a mobile
 * token can never be used as a partner token and vice-versa.
 */

const JWT_SECRET = process.env.MOBILE_JWT_SECRET ?? "";
const JWT_ISSUER = process.env.MOBILE_JWT_ISSUER ?? "myopiamanage.org";
const ACCESS_TTL_SECONDS = 60 * 60 * 24 * 14; // 14 days

export type PartnerJWTPayload = { sub: string; kind: "partner" };

function assertSecret(): string {
  if (!JWT_SECRET) throw new Error("MOBILE_JWT_SECRET is not set.");
  return JWT_SECRET;
}

export function signPartnerToken(accountId: string): {
  token: string;
  expiresIn: number;
} {
  const options: SignOptions = { issuer: JWT_ISSUER, expiresIn: ACCESS_TTL_SECONDS };
  const token = jwt.sign({ sub: accountId, kind: "partner" }, assertSecret(), options);
  return { token, expiresIn: ACCESS_TTL_SECONDS };
}

export function verifyPartnerToken(token: string): PartnerJWTPayload {
  const payload = jwt.verify(token, assertSecret(), { issuer: JWT_ISSUER }) as PartnerJWTPayload;
  if (payload.kind !== "partner") throw new Error("not a partner token");
  return payload;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      partner?: PartnerJWTPayload;
    }
  }
}

/** Requires a valid hospital-partner access token. */
export const partnerRequired: RequestHandler = (req, res, next) => {
  const header = req.get("Authorization");
  if (!header || !header.startsWith("Bearer ")) {
    res.status(401).json({ error: "missing bearer", code: "unauthorized" });
    return;
  }
  try {
    req.partner = verifyPartnerToken(header.slice("Bearer ".length).trim());
    next();
  } catch {
    res.status(401).json({ error: "invalid token", code: "unauthorized" });
  }
};
