/**
 * 빌키 발급에 보내는 카드 정보 암호화가 나이스 문서와 같은지.
 *
 *   npx tsx scripts/check-billing-enc.ts
 *
 * 틀리면 나이스가 "복호화 실패"로 거절하는데, 그 말만으로는 키가 틀렸는지
 * 식이 틀렸는지 알 수 없다. 문서의 예시(평문·키·결과)를 그대로 맞춰 본다.
 * nicepay-manual api/payment-subscribe.md "encData 필드 암호화 예시 (AES-256)".
 */
import assert from "assert";

import { cardPlain, encryptCard } from "../src/services/nicepay";

const plain = cardPlain({
  cardNo: "1234567890123456",
  expYear: "25",
  expMonth: "12",
  idNo: "800101",
  cardPw: "12",
});
assert.strictEqual(plain, "cardNo=1234567890123456&expYear=25&expMonth=12&idNo=800101&cardPw=12");

assert.strictEqual(
  encryptCard(plain, "2dcc2a0d63bf469490bb19a201be3735"),
  "6ecfe97e521bc67c3053d74a9dbdba53033d343fc9e8e38e730964b22ef2e4a59607171b00a9da977141b3f79fffa1e80a16c08bc58666b479f554a966a363414347e62f2621f8df220c7a4a545592d0",
  "AES-256-CBC(encMode A2) 결과가 문서 예시와 다르다",
);

assert.throws(() => encryptCard(plain, "short"), /32/, "키 길이가 틀리면 보내기 전에 멈춘다");

console.log("billing encryption ok");
