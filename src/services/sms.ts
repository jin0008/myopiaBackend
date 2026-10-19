import crypto from "crypto";

/**
 * 문자 발송 - 솔라피(solapi.com).
 *
 * SDK 없이 REST 한 번이다. 인증 헤더는 HMAC-SHA256(date + salt) 이고,
 * 발신번호는 솔라피 콘솔에 미리 등록한 번호여야 한다(발신번호 사전등록제).
 * 등록 안 된 번호로 보내면 솔라피가 거절한다.
 */

const apiKey = process.env.SOLAPI_API_KEY;
const apiSecret = process.env.SOLAPI_API_SECRET;
const from = process.env.SMS_FROM?.replace(/\D/g, "");

/** 설정이 다 있는지. 인증번호처럼 "안 보내면 실패"인 곳에서 쓴다. */
export function isSmsConfigured(): boolean {
  return !!(apiKey && apiSecret && from);
}

export async function sendSms(to: string, text: string): Promise<void> {
  if (!apiKey || !apiSecret || !from) throw new Error("SMS is not configured");
  const date = new Date().toISOString();
  const salt = crypto.randomBytes(16).toString("hex");
  const signature = crypto
    .createHmac("sha256", apiSecret)
    .update(date + salt)
    .digest("hex");
  const res = await fetch("https://api.solapi.com/messages/v4/send", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `HMAC-SHA256 apiKey=${apiKey}, date=${date}, salt=${salt}, signature=${signature}`,
    },
    body: JSON.stringify({ message: { to, from, text } }),
  });
  if (!res.ok) {
    throw new Error(`solapi ${res.status}: ${await res.text()}`);
  }
}
