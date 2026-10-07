import nodemailer from "nodemailer";

const host = process.env.SMTP_HOST;
const port = process.env.SMTP_PORT;
const user = process.env.SMTP_USER;
const pass = process.env.SMTP_PASS;
const from = process.env.SMTP_FROM;
// 발신 주소는 우리 도메인이어야 DKIM 서명이 붙는다(네이버·구글이 그걸 본다).
// 그래서 no-reply@myodoc.co.kr 로 나가는데, 그 함에는 아무도 없다.
// 답장은 실제로 읽는 주소로 흘려보낸다.
const replyTo = process.env.SMTP_REPLY_TO;

let transporter: nodemailer.Transporter | null = null;

if (host && port) {
  transporter = nodemailer.createTransport({
    host,
    port: Number(port),
    secure: Number(port) === 465,
    auth: user && pass ? { user, pass } : undefined,
  });
} else {
  console.warn(
    "SMTP_HOST/SMTP_PORT not configured — outgoing emails will be skipped.",
  );
}

/** SMTP 가 설정돼 있는지. 인증번호처럼 "안 보내면 실패"인 곳에서 쓴다. */
export function isEmailConfigured(): boolean {
  return transporter != null;
}

export async function sendEmail(
  to: string[],
  subject: string,
  html: string,
  /** 이 메일만 답장을 다른 곳으로. 광고 문의 알림은 문의한 사람에게 바로 답장한다. */
  replyToOverride?: string,
): Promise<void> {
  if (to.length === 0) {
    return;
  }
  if (transporter == null) {
    console.warn("sendEmail called but SMTP transporter is not configured.");
    return;
  }
  await transporter.sendMail({
    from: from ?? user,
    replyTo: replyToOverride ?? replyTo,
    to,
    subject,
    html,
  });
}

/** 메일 본문에 사용자가 쓴 글을 넣을 때. 그대로 넣으면 남이 쓴 HTML 이 메일에 그려진다. */
export function escapeHtml(v: string): string {
  return v.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

/** 운영자 알림을 받는 주소들. 쉼표로 여러 개("a@x.kr,b@y.com"). 비우면 공용 주소. */
const ADMIN_ALERT_TO = (process.env.ADMIN_ALERT_EMAIL || "myodoc@idx.ai.kr")
  .split(",")
  .map((v) => v.trim())
  .filter((v) => v !== "");

/** 관리자 페이지 주소. 알림 메일에서 바로 처리하러 가게 링크를 단다. */
export const ADMIN_URL = (process.env.PARTNER_ORIGIN ?? "https://myopiamanage.org") + "/admin";

/**
 * 운영자에게 알린다. 기다리지 않는다.
 *
 * 알림은 곁다리다. 메일 서버가 느리거나 죽었다고 업체의 인증 신청이나
 * 광고 문의가 실패하면 안 된다 - 접수는 이미 DB 에 들어갔고, 관리자
 * 페이지에서 보인다.
 */
export function alertAdmin(subject: string, html: string, replyTo?: string): Promise<void> {
  // 실패를 삼킨 약속을 돌려준다. 라우트는 기다리지 않고, 끝나면 내리는
  // 스크립트(명부 갱신)는 기다린다 - 안 기다리면 보내기 전에 프로세스가 끝난다.
  return sendEmail(ADMIN_ALERT_TO, subject, html, replyTo).catch((err) =>
    console.error("[알림] 운영자 메일을 보내지 못했다", subject, err),
  );
}
