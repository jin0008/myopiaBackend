import crypto from "node:crypto";
import jwt, { SignOptions } from "jsonwebtoken";
import { RequestHandler } from "express";
import prisma from "./prisma";

/**
 * Mobile-app authentication primitives.
 *
 * This is intentionally separate from the existing session-based web auth
 * (see src/lib/session.ts). The iOS app uses stateless JWT access tokens
 * plus rotating opaque refresh tokens that are stored (hashed) in the
 * mobile_refresh_token table.
 */

const JWT_SECRET = process.env.MOBILE_JWT_SECRET ?? "";
const JWT_ISSUER = process.env.MOBILE_JWT_ISSUER ?? "myopiamanage.org";

export const ACCESS_TTL_SECONDS = 60 * 60; // 1 hour
export const REFRESH_TTL_SECONDS = 60 * 60 * 24 * 90; // 90 days

export type MobileJWTPayload = {
  sub: string; // user id
  role: "regular_user"; // only role issued for the mobile app
};

function assertSecret(): string {
  if (!JWT_SECRET) {
    throw new Error(
      "MOBILE_JWT_SECRET is not set. Generate 64 random bytes and add it to .env",
    );
  }
  return JWT_SECRET;
}

export function signAccessToken(payload: MobileJWTPayload): {
  token: string;
  expiresIn: number;
} {
  const options: SignOptions = {
    issuer: JWT_ISSUER,
    expiresIn: ACCESS_TTL_SECONDS,
  };
  const token = jwt.sign(payload, assertSecret(), options);
  return { token, expiresIn: ACCESS_TTL_SECONDS };
}

export function verifyAccessToken(token: string): MobileJWTPayload {
  return jwt.verify(token, assertSecret(), {
    issuer: JWT_ISSUER,
  }) as MobileJWTPayload;
}

export function hashRefreshToken(raw: string): string {
  return crypto.createHash("sha256").update(raw).digest("hex");
}

/**
 * Creates a new opaque refresh token, stores its sha256 hash against
 * the given user, and returns the raw token to return to the client.
 *
 * @param rotatedFromId — if this is a rotation, the id of the refresh
 *                        token row that produced it (for audit).
 */
export async function issueRefreshToken(
  userId: string,
  rotatedFromId?: string,
): Promise<string> {
  const raw = crypto.randomBytes(48).toString("base64url");
  const tokenHash = hashRefreshToken(raw);
  const expiresAt = new Date(Date.now() + REFRESH_TTL_SECONDS * 1000);
  await prisma.mobile_refresh_token.create({
    data: {
      user_id: userId,
      token_hash: tokenHash,
      expires_at: expiresAt,
      rotated_from: rotatedFromId,
    },
  });
  return raw;
}

/**
 * Validates and rotates a refresh token. Returns { userId, newRefreshToken }.
 * Throws if the token is unknown, expired, revoked, or already rotated.
 */
export async function rotateRefreshToken(raw: string): Promise<{
  userId: string;
  newRefreshToken: string;
}> {
  const tokenHash = hashRefreshToken(raw);
  const row = await prisma.mobile_refresh_token.findUnique({
    where: { token_hash: tokenHash },
  });
  if (row == null) throw new Error("unknown refresh token");
  if (row.revoked_at != null) throw new Error("refresh token revoked");
  if (row.expires_at < new Date()) throw new Error("refresh token expired");

  // Mark as rotated (revoked_at = now) and issue the new one.
  await prisma.mobile_refresh_token.update({
    where: { id: row.id },
    data: { revoked_at: new Date() },
  });
  const newRefreshToken = await issueRefreshToken(row.user_id, row.id);
  return { userId: row.user_id, newRefreshToken };
}

/**
 * Revokes every non-revoked refresh token that still belongs to this user.
 * Used by POST /auth/logout.
 */
export async function revokeAllRefreshTokens(userId: string): Promise<void> {
  await prisma.mobile_refresh_token.updateMany({
    where: { user_id: userId, revoked_at: null },
    data: { revoked_at: new Date() },
  });
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      mobileUser?: MobileJWTPayload;
    }
  }
}

/** Express middleware that requires a valid mobile access token. */
export const requireMobileAuth: RequestHandler = (req, res, next) => {
  const header = req.get("Authorization");
  if (!header || !header.startsWith("Bearer ")) {
    res.status(401).json({ error: "missing bearer", code: "unauthorized" });
    return;
  }
  try {
    const payload = verifyAccessToken(header.slice("Bearer ".length).trim());
    req.mobileUser = payload;
    next();
  } catch {
    res.status(401).json({ error: "invalid token", code: "unauthorized" });
  }
};
