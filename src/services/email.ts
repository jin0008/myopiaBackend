import nodemailer from "nodemailer";

const host = process.env.SMTP_HOST;
const port = process.env.SMTP_PORT;
const user = process.env.SMTP_USER;
const pass = process.env.SMTP_PASS;
const from = process.env.SMTP_FROM;

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
    to,
    subject,
    html,
  });
}
