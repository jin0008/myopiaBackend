/**
 * 웹 2단계 인증 계산을 RFC 값으로 본다.
 *
 *   npx tsx scripts/check-web-2fa.ts
 *
 * TOTP 는 틀려도 "코드가 안 맞습니다"로만 드러나 원인을 찾기 어렵다.
 * 표준 시험값(RFC 6238 부록 B, RFC 4648)과 맞는지 여기서 먼저 본다.
 */
import assert from "assert";
import {
  base32Decode,
  base32Encode,
  hashBackupCode,
  hotp,
  newBackupCodes,
  newTotpSecret,
  passwordPolicyError,
  verifyTotp,
} from "../src/lib/totp";

// RFC 4648 base32
assert.strictEqual(base32Encode(Buffer.from("foobar")), "MZXW6YTBOI");
assert.strictEqual(base32Decode("MZXW6YTBOI").toString(), "foobar");

// RFC 6238 부록 B (SHA-1, 8자리)
const key = Buffer.from("12345678901234567890");
for (const [t, want] of [
  [59, "94287082"],
  [1111111109, "07081804"],
  [1234567890, "89005924"],
  [2000000000, "69279037"],
] as const) {
  assert.strictEqual(hotp(key, Math.floor(t / 30), 8), want, `t=${t}`);
}

// 검증: 맞는 칸, 앞뒤 한 칸, 재사용 막기, 형식
const secret = base32Encode(key);
const now = 1234567890 * 1000;
const code = hotp(key, Math.floor(1234567890 / 30));
assert.strictEqual(verifyTotp(secret, code, null, now), Math.floor(1234567890 / 30));
assert.strictEqual(verifyTotp(secret, code, null, now + 30_000), Math.floor(1234567890 / 30));
assert.strictEqual(verifyTotp(secret, code, null, now + 90_000), null);
assert.strictEqual(verifyTotp(secret, code, Math.floor(1234567890 / 30), now), null);
assert.strictEqual(verifyTotp(secret, "12345", null, now), null);
assert.strictEqual(base32Decode(newTotpSecret()).length, 20);

// 백업 코드
const codes = newBackupCodes();
assert.strictEqual(new Set(codes).size, 10);
assert.match(codes[0], /^[A-Z2-9]{5}-[A-Z2-9]{5}$/);
assert.strictEqual(hashBackupCode(codes[0].toLowerCase().replace("-", " ")), hashBackupCode(codes[0]));

// 비밀번호 규칙
assert.ok(passwordPolicyError("1234"));
assert.ok(passwordPolicyError("password1!"));
assert.ok(passwordPolicyError("Password1"));
assert.ok(passwordPolicyError("Pa1!"));
assert.strictEqual(passwordPolicyError("Password1!"), null);

console.log("ok");
