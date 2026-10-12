import crypto from "crypto";

/**
 * 웹(myopiamanage) 로그인 2단계 인증. RFC 6238 TOTP — 30초, 6자리, SHA-1.
 * Google Authenticator·Microsoft Authenticator 등 아무 인증 앱이나 읽는
 * 기본값이다. 값을 바꾸면 일부 앱이 조용히 틀린 코드를 낸다.
 */
const STEP_SECONDS = 30;
const DIGITS = 6;

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.replace(/=+$/, "").replace(/\s+/g, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error("invalid base32");
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** 20바이트(160비트) — RFC 4226 이 권하는 SHA-1 키 길이. */
export function newTotpSecret(): string {
  return base32Encode(crypto.randomBytes(20));
}

export function hotp(key: Buffer, counter: number, digits = DIGITS): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac("sha1", key).update(msg).digest();
  const off = h[h.length - 1] & 0xf;
  const bin = (h.readUInt32BE(off) & 0x7fffffff) % 10 ** digits;
  return String(bin).padStart(digits, "0");
}

export function currentStep(nowMs = Date.now()): number {
  return Math.floor(nowMs / 1000 / STEP_SECONDS);
}

/**
 * 맞으면 맞은 시간 칸(step)을, 아니면 null.
 *
 * 앞뒤 한 칸(±30초)까지 받는다 - 폰 시계가 조금 어긋나는 일은 흔하다.
 * lastStep 이하의 칸은 받지 않는다. 같은 코드를 30초 안에 다시 넣는
 * 재사용(어깨너머로 본 코드, 가로챈 요청)을 막는다.
 */
export function verifyTotp(
  secretB32: string,
  code: string,
  lastStep: number | null,
  nowMs = Date.now(),
): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const key = base32Decode(secretB32);
  const now = currentStep(nowMs);
  for (const step of [now - 1, now, now + 1]) {
    if (lastStep != null && step <= lastStep) continue;
    const expected = hotp(key, step);
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(code))) return step;
  }
  return null;
}

export function otpauthUrl(secretB32: string, account: string): string {
  const issuer = "myopiamanage";
  return (
    `otpauth://totp/${encodeURIComponent(`${issuer}:${account}`)}` +
    `?secret=${secretB32}&issuer=${issuer}&algorithm=SHA1&digits=${DIGITS}&period=${STEP_SECONDS}`
  );
}

/** 백업 코드: 10자리 영숫자 10개. 헷갈리는 0/O, 1/I/L 은 뺀다. */
const BACKUP_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export function newBackupCodes(n = 10): string[] {
  return Array.from({ length: n }, () => {
    let s = "";
    for (let i = 0; i < 10; i++) s += BACKUP_ALPHABET[crypto.randomInt(BACKUP_ALPHABET.length)];
    return `${s.slice(0, 5)}-${s.slice(5)}`;
  });
}

/** 백업 코드는 50비트라 느린 해시가 필요 없다. 대소문자·하이픈은 무시한다. */
export function hashBackupCode(code: string): string {
  const norm = code.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return crypto.createHash("sha256").update(`backup:${norm}`).digest("hex");
}

/**
 * 웹 비밀번호 규칙: 8자 이상, 영문 대문자·소문자·숫자·특수문자 모두.
 * 맞으면 null, 아니면 무엇이 빠졌는지 한 문장.
 */
export function passwordPolicyError(pw: string): string | null {
  const missing: string[] = [];
  if (!/[A-Z]/.test(pw)) missing.push("uppercase letter");
  if (!/[a-z]/.test(pw)) missing.push("lowercase letter");
  if (!/[0-9]/.test(pw)) missing.push("number");
  if (!/[^A-Za-z0-9]/.test(pw)) missing.push("special character");
  if (pw.length < 8) return "Password must be at least 8 characters.";
  if (missing.length > 0) return `Password must include: ${missing.join(", ")}.`;
  return null;
}
