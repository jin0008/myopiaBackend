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

export async function sendEmail(
  to: string[],
  subject: string,
  html: string,
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
    replyTo,
    to,
    subject,
    html,
  });
}
