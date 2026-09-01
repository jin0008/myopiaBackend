import prisma from "./prisma";
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

/**
 * Requires a valid hospital-partner access token.
 *
 * 토큰 서명만 보지 않고 계정도 확인한다. 파트너 토큰은 14일짜리 JWT 라
 * 서버에 폐기 목록이 없어서, 비밀번호를 바꿔도 남이 들고 있던 토큰이
 * 그대로 살아 있다. 그러면 비밀번호를 바꾸는 일이 침입자를 내보내지 못한다.
 *
 * 요청마다 조회가 한 번 늘지만, 파트너 API 는 병원 몇 곳이 프로필을 고칠
 * 때만 쓰여서 부담이 되지 않는다.
 */
export const partnerRequired: RequestHandler = async (req, res, next) => {
  const header = req.get("Authorization");
  if (!header || !header.startsWith("Bearer ")) {
    res.status(401).json({ error: "missing bearer", code: "unauthorized" });
    return;
  }
  let payload: PartnerJWTPayload;
  try {
    payload = verifyPartnerToken(header.slice("Bearer ".length).trim());
  } catch {
    res.status(401).json({ error: "invalid token", code: "unauthorized" });
    return;
  }

  const account = await prisma.hospital_account.findUnique({
    where: { id: payload.sub },
    select: { password_changed_at: true },
  });
  if (account == null) {
    res.status(401).json({ error: "account gone", code: "unauthorized" });
    return;
  }
  // iat 는 초 단위다.
  const issuedAt = (payload as { iat?: number }).iat;
  if (
    account.password_changed_at != null &&
    issuedAt != null &&
    issuedAt * 1000 < account.password_changed_at.getTime()
  ) {
    res.status(401).json({ error: "password changed", code: "unauthorized" });
    return;
  }

  req.partner = payload;
  next();
};
