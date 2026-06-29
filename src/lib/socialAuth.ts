import { OAuth2Client } from "google-auth-library";
import { createRemoteJWKSet, jwtVerify } from "jose";

/**
 * Social-login token verification for the mobile app.
 *
 * Each function verifies a token issued to the iOS app by the provider's
 * SDK and returns the provider's stable user identifier (`subject`) and
 * the email if the provider releases it.
 */

export type SocialIdentity = {
  subject: string;
  email: string | null;
};

/* ---------------- Apple ---------------- */

// Apple's JWKS for id_token verification.
const appleJWKS = createRemoteJWKSet(
  new URL("https://appleid.apple.com/auth/keys"),
);

export async function verifyAppleIdToken(token: string): Promise<SocialIdentity> {
  const bundleId = process.env.APPLE_BUNDLE_ID;
  if (!bundleId) throw new Error("APPLE_BUNDLE_ID not set");

  const { payload } = await jwtVerify(token, appleJWKS, {
    issuer: "https://appleid.apple.com",
    audience: bundleId,
  });

  if (!payload.sub) throw new Error("apple token missing sub");
  const email = typeof payload.email === "string" ? payload.email : null;
  return { subject: payload.sub, email };
}

/* ---------------- Google ---------------- */

const googleClient = new OAuth2Client();

export async function verifyGoogleIdToken(token: string): Promise<SocialIdentity> {
  const iosClientId = process.env.GOOGLE_IOS_CLIENT_ID;
  if (!iosClientId) throw new Error("GOOGLE_IOS_CLIENT_ID not set");

  const ticket = await googleClient.verifyIdToken({
    idToken: token,
    // Allow the web client id too, for dev convenience.
    audience: [iosClientId, process.env.GOOGLE_CLIENT_ID ?? ""].filter(Boolean),
  });
  const payload = ticket.getPayload();
  if (!payload || !payload.sub) throw new Error("google token invalid");
  return { subject: payload.sub, email: payload.email ?? null };
}

/* ---------------- Kakao ---------------- */

export async function verifyKakaoAccessToken(
  accessToken: string,
): Promise<SocialIdentity> {
  const resp = await fetch("https://kapi.kakao.com/v2/user/me", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!resp.ok) throw new Error(`kakao verify failed: ${resp.status}`);
  const data: any = await resp.json();
  if (data?.id == null) throw new Error("kakao response missing id");
  return {
    subject: String(data.id),
    email:
      typeof data?.kakao_account?.email === "string"
        ? data.kakao_account.email
        : null,
  };
}

/* ---------------- Naver ---------------- */

export async function verifyNaverAccessToken(
  accessToken: string,
): Promise<SocialIdentity> {
  const resp = await fetch("https://openapi.naver.com/v1/nid/me", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!resp.ok) throw new Error(`naver verify failed: ${resp.status}`);
  const data: any = await resp.json();
  if (data?.response?.id == null) throw new Error("naver response missing id");
  return {
    subject: String(data.response.id),
    email:
      typeof data.response?.email === "string" ? data.response.email : null,
  };
}

/* ---------------- Dispatch ---------------- */

export type SocialProvider = "apple" | "google" | "kakao" | "naver";

export async function verifySocialToken(
  provider: SocialProvider,
  token: string,
): Promise<SocialIdentity> {
  switch (provider) {
    case "apple":
      return verifyAppleIdToken(token);
    case "google":
      return verifyGoogleIdToken(token);
    case "kakao":
      return verifyKakaoAccessToken(token);
    case "naver":
      return verifyNaverAccessToken(token);
  }
}
