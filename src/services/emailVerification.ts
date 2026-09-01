import crypto from "crypto";
import jwt from "jsonwebtoken";

import prisma from "../lib/prisma";
import { isEmailConfigured, sendEmail } from "./email";

/**
 * 이메일 인증 코드.
 *
 * 링크가 아니라 6자리 숫자를 쓴다. 링크를 누르면 메일 앱이 브라우저를 열고,
 * 거기서 앱으로 돌아오려면 딥링크를 따로 붙여야 한다. 코드를 옮겨 적는 쪽이
 * 플랫폼을 안 타고 실패할 여지도 적다.
 *
 * 인증을 통과하면 user 를 만드는 대신 짧게 사는 토큰을 준다. 미인증 계정을
 * 먼저 만들어 두면 확인하지 않은 행이 쌓이고 아이디가 선점된다.
 */

const CODE_TTL_MS = 5 * 60 * 1000;
/** 재발송 간격. 이보다 촘촘히 누르면 이전 코드를 그대로 두고 거절한다. */
const RESEND_COOLDOWN_MS = 60 * 1000;
/** 6자리는 100만 분의 1이라, 끝까지 넣어보면 뚫린다. 시도를 막아야 의미가 있다. */
const MAX_ATTEMPTS = 5;
const TICKET_TTL_SECONDS = 15 * 60;

/**
 * 코드의 쓰임. 섞이면 안 된다 - 가입용 코드로 비밀번호를 바꿀 수 있으면
 * 남의 주소로 가입 코드를 받아 그 계정을 가져갈 수 있다.
 * partner_reset 은 앱 사용자가 아니라 병원 계정용이라 또 따로 둔다.
 */
export type VerificationPurpose = "signup" | "reset" | "partner_reset";

export class VerificationError extends Error {
  constructor(
    readonly code:
      | "unavailable"
      | "cooldown"
      | "not_found"
      | "expired"
      | "too_many_attempts"
      | "mismatch",
    message: string,
  ) {
    super(message);
  }
}

function hashCode(email: string, code: string): string {
  // 이메일을 같이 넣어, 한 코드의 해시가 다른 주소에서 재사용되지 않게 한다.
  return crypto
    .createHash("sha256")
    .update(`${email.toLowerCase()}:${code}`)
    .digest("hex");
}

function newCode(): string {
  // Math.random 은 예측 가능하다. 인증 코드는 추측을 막는 것이 전부다.
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
}

function ticketSecret(): string {
  const s = process.env.MOBILE_JWT_SECRET;
  if (!s) throw new Error("MOBILE_JWT_SECRET is not set");
  return s;
}

/**
 * 코드를 만들어 보낸다.
 *
 * 이미 보낸 코드가 쿨다운 안이면 거절한다. 새로 만들어 덮어쓰면, 먼저 온
 * 메일을 보고 입력하는 사람이 계속 틀리게 된다.
 */
export async function issueCode(
  emailRaw: string,
  purpose: VerificationPurpose,
): Promise<void> {
  const email = emailRaw.toLowerCase();
  const recent = await prisma.email_verification.findFirst({
    where: { email, purpose, consumed_at: null },
    orderBy: { created_at: "desc" },
  });
  if (
    recent != null &&
    Date.now() - recent.created_at.getTime() < RESEND_COOLDOWN_MS
  ) {
    throw new VerificationError("cooldown", "잠시 후 다시 시도해 주세요.");
  }

  // 발송이 꺼져 있으면 성공이라고 하지 않는다. sendEmail 은 SMTP 설정이
  // 없을 때 경고만 찍고 조용히 돌아오는데, 그대로 두면 화면에는 "보냈다"고
  // 뜨고 사용자는 오지 않는 메일을 기다린다.
  if (!isEmailConfigured()) {
    throw new VerificationError(
      "unavailable",
      "인증번호를 보낼 수 없습니다. 잠시 후 다시 시도해 주세요.",
    );
  }

  const code = newCode();
  // 메일부터 보낸다. 코드 행을 먼저 만들면 발송이 실패했을 때 쓸 수 없는
  // 코드가 남고, 쿨다운까지 걸려 사용자가 60초 동안 다시 시도하지 못한다.
  await sendEmail([email], "마이오닥 인증번호", codeEmailHtml(code));

  // 이 주소로 아직 살아 있는 코드는 모두 무효로 한다. 코드가 여러 개
  // 유효하면 시도 횟수 제한이 사실상 배수로 늘어난다.
  await prisma.email_verification.updateMany({
    where: { email, purpose, consumed_at: null },
    data: { consumed_at: new Date() },
  });
  await prisma.email_verification.create({
    data: {
      email,
      purpose,
      code_hash: hashCode(email, code),
      expires_at: new Date(Date.now() + CODE_TTL_MS),
    },
  });
}

/**
 * 코드를 확인하고 가입에 쓸 티켓을 돌려준다.
 *
 * 틀린 횟수는 코드 행에 쌓는다. IP 로만 세면 주소를 바꿔가며 계속 넣을 수 있다.
 */
export async function verifyCode(
  emailRaw: string,
  code: string,
  purpose: VerificationPurpose,
): Promise<string> {
  const email = emailRaw.toLowerCase();
  const row = await prisma.email_verification.findFirst({
    where: { email, purpose, consumed_at: null },
    orderBy: { created_at: "desc" },
  });
  if (row == null) {
    throw new VerificationError("not_found", "인증번호를 먼저 요청해 주세요.");
  }
  if (row.expires_at.getTime() < Date.now()) {
    throw new VerificationError("expired", "인증번호가 만료되었습니다.");
  }
  if (row.attempts >= MAX_ATTEMPTS) {
    throw new VerificationError(
      "too_many_attempts",
      "여러 번 틀렸습니다. 인증번호를 다시 요청해 주세요.",
    );
  }
  if (row.code_hash !== hashCode(email, code)) {
    await prisma.email_verification.update({
      where: { id: row.id },
      data: { attempts: { increment: 1 } },
    });
    throw new VerificationError("mismatch", "인증번호가 올바르지 않습니다.");
  }

  await prisma.email_verification.update({
    where: { id: row.id },
    data: { consumed_at: new Date() },
  });
  return jwt.sign({ email, purpose }, ticketSecret(), {
    expiresIn: TICKET_TTL_SECONDS,
  });
}

/**
 * 가입 요청이 들고 온 티켓이 그 이메일의 것인지 확인한다.
 * 티켓의 이메일과 가입하려는 이메일이 다르면, 남의 주소를 인증하고 자기
 * 주소로 가입하는 길이 열린다.
 */
export function assertTicket(
  ticket: string,
  emailRaw: string,
  purpose: VerificationPurpose,
): void {
  let payload: { email?: string; purpose?: string };
  try {
    payload = jwt.verify(ticket, ticketSecret()) as typeof payload;
  } catch {
    throw new VerificationError("expired", "인증이 만료되었습니다. 다시 인증해 주세요.");
  }
  if (payload.email !== emailRaw.toLowerCase() || payload.purpose !== purpose) {
    throw new VerificationError("mismatch", "인증 정보가 일치하지 않습니다.");
  }
}

/** 지난 코드 정리. 남겨둬도 쓰이지 않지만 계속 쌓인다. */
export async function purgeExpiredCodes(): Promise<number> {
  const { count } = await prisma.email_verification.deleteMany({
    where: { expires_at: { lt: new Date(Date.now() - 24 * 60 * 60 * 1000) } },
  });
  return count;
}

function codeEmailHtml(code: string): string {
  return `
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;color:#151A21">
  <p style="margin:0 0 24px;font-size:18px;font-weight:700">마이오닥 인증번호</p>
  <p style="margin:0 0 20px;font-size:15px;line-height:1.6;color:#5B6472">
    아래 번호를 앱에 입력해 주세요.
  </p>
  <p style="margin:0 0 20px;font-size:32px;font-weight:800;letter-spacing:8px;color:#1A73E8">
    ${code}
  </p>
  <p style="margin:0 0 8px;font-size:13px;color:#5B6472">5분 안에 입력해야 합니다.</p>
  <p style="margin:0;font-size:13px;color:#5B6472">
    요청하지 않으셨다면 이 메일을 무시하셔도 됩니다.
  </p>
</div>`;
}
