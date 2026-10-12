import express from "express";
import bcrypt from "bcrypt";
import prisma from "../lib/prisma";

import { clearSession, generateSession, getAuthSession } from "../lib/session";
import jwt from "jsonwebtoken";
import {
  hashBackupCode,
  newBackupCodes,
  newTotpSecret,
  otpauthUrl,
  passwordPolicyError,
  verifyTotp,
} from "../lib/totp";
import { decryptSymmetric, encryptSymmetric } from "../services/encrpytion";
import {
  issueCode,
  verifyCode,
  assertTicket,
  VerificationError,
} from "../services/emailVerification";
import { PrismaClientKnownRequestError } from "@prisma/client/runtime/library";
import { loginRequired, validateRequestBody } from "../lib/middlewares";
import { CONSENT_VERSION, consentRows } from "../lib/consent";

import { OAuth2Client } from "google-auth-library";

import zod from "zod";

const client = new OAuth2Client();

const router = express.Router();

router.post("/passwordLogin", async (req, res) => {
  const username = req.body.username;
  const password = req.body.password;

  if (
    typeof username !== "string" ||
    typeof password !== "string" ||
    !username ||
    !password
  ) {
    res.sendStatus(400);
    return;
  }

  const auth = await prisma.password_auth.findUnique({
    where: {
      username: username,
    },

    include: {
      user: true,
    },
  });

  if (auth == null) {
    res.status(401).json({ message: "Invalid username or password" });
    return;
  }

  const match = await bcrypt.compare(password, auth.hash);
  if (!match) {
    res.status(401).json({ message: "Invalid username or password" });
    return;
  }
  // 첫 단계만 통과했다. 세션은 2단계까지 마친 뒤에 준다. 지금 비밀번호가
  // 규칙에 안 맞으면 먼저 바꾸게 한다 - 평문을 아는 건 이 순간뿐이다.
  res.json(
    await nextLoginStep(
      auth.user.id,
      passwordPolicyError(password) != null,
      req.body.deviceTokens,
    ),
  );
});

router.post("/googleLogin", async (req, res) => {
  const token = req.body.token;
  if (typeof token !== "string" || !token) {
    res.sendStatus(400);
    return;
  }

  const ticket = await client.verifyIdToken({
    idToken: token,
    audience: process.env.GOOGLE_CLIENT_ID,
  });

  const payload = ticket.getPayload();
  if (payload == null) {
    res.sendStatus(401);
    return;
  }

  const googleAuth = await prisma.google_auth.findUnique({
    where: {
      google_identity: payload.sub,
    },
    include: {
      user: true,
    },
  });

  if (googleAuth == null) {
    res.status(401).json({ message: "Google account not associated" });
    return;
  }

  res.json(await nextLoginStep(googleAuth.user.id, false, req.body.deviceTokens));
});

/* ------------------------------------------------------------------ *
 * 로그인 2단계                                                         *
 *                                                                    *
 * 아이디·비밀번호(또는 Google)가 맞으면 세션 대신 10분짜리 티켓을 준다.     *
 * 티켓으로 할 수 있는 건 남은 단계(비밀번호 변경, 2단계 등록, 코드 입력)뿐  *
 * 이고, 세션은 2단계 코드가 맞은 뒤에만 나간다.                          *
 * ------------------------------------------------------------------ */

const LOGIN_TICKET_AUD = "web-login";
const LOGIN_TICKET_TTL = "10m";

function loginTicketSecret(): string {
  const s = process.env.MOBILE_JWT_SECRET;
  if (!s) throw new Error("MOBILE_JWT_SECRET is not set");
  return s;
}

type LoginTicket = { sub: string; pwWeak: boolean };

function signLoginTicket(userId: string, pwWeak: boolean): string {
  return jwt.sign({ pwWeak }, loginTicketSecret(), {
    subject: userId,
    audience: LOGIN_TICKET_AUD,
    expiresIn: LOGIN_TICKET_TTL,
  });
}

function readLoginTicket(ticket: unknown): LoginTicket | null {
  if (typeof ticket !== "string") return null;
  try {
    const p = jwt.verify(ticket, loginTicketSecret(), {
      audience: LOGIN_TICKET_AUD,
    }) as jwt.JwtPayload;
    if (typeof p.sub !== "string") return null;
    return { sub: p.sub, pwWeak: p.pwWeak === true };
  } catch {
    return null;
  }
}

/* "이 브라우저 30일 기억하기".
 *
 * 2단계를 마친 브라우저에 30일짜리 서명 토큰을 준다. 그 브라우저에서는
 * 비밀번호(또는 Google)만 맞으면 코드를 묻지 않는다. 토큰에는 2단계를
 * 등록한 시각을 넣어 둔다 - 관리자가 초기화하면 그 시각이 바뀌어, 기억해 둔
 * 브라우저가 한꺼번에 무효가 된다. 비밀번호가 약해 바꿔야 하는 단계는
 * 기억과 상관없이 거친다. */
const DEVICE_AUD = "web-trusted-device";
const DEVICE_TTL = "30d";

function signDeviceToken(userId: string, enabledAt: Date): string {
  return jwt.sign({ ver: enabledAt.getTime() }, loginTicketSecret(), {
    subject: userId,
    audience: DEVICE_AUD,
    expiresIn: DEVICE_TTL,
  });
}

function trustedDevice(tokens: unknown, userId: string, enabledAt: Date): boolean {
  if (!Array.isArray(tokens)) return false;
  // 한 브라우저를 여러 사람이 쓰면 토큰이 여럿일 수 있다. 몇 개만 본다.
  return tokens.slice(0, 5).some((t) => {
    if (typeof t !== "string") return false;
    try {
      const p = jwt.verify(t, loginTicketSecret(), { audience: DEVICE_AUD }) as jwt.JwtPayload;
      return p.sub === userId && p.ver === enabledAt.getTime();
    } catch {
      return false;
    }
  });
}

async function nextLoginStep(userId: string, pwWeak: boolean, deviceTokens?: unknown) {
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { totp_enabled_at: true },
  });
  if (!pwWeak && user.totp_enabled_at != null && trustedDevice(deviceTokens, userId, user.totp_enabled_at)) {
    return { next: "signed_in" as const, ...(await generateSession(userId)) };
  }
  const next = pwWeak
    ? "change_password"
    : user.totp_enabled_at == null
      ? "setup_2fa"
      : "verify_2fa";
  return { next, ticket: signLoginTicket(userId, pwWeak) };
}

const TICKET_EXPIRED = {
  message: "Your sign-in has expired. Please sign in again.",
};

/** POST /auth/login/password — 규칙에 안 맞는 비밀번호를 로그인 중에 바꾼다. */
router.post("/login/password", async (req, res) => {
  const t = readLoginTicket(req.body?.ticket);
  if (t == null || !t.pwWeak) {
    res.status(401).json(TICKET_EXPIRED);
    return;
  }
  const newPassword = req.body?.newPassword;
  if (typeof newPassword !== "string") {
    res.sendStatus(400);
    return;
  }
  const policy = passwordPolicyError(newPassword);
  if (policy) {
    res.status(400).json({ message: policy });
    return;
  }
  await prisma.password_auth.update({
    where: { user_id: t.sub },
    data: { hash: await bcrypt.hash(newPassword, 12) },
  });
  res.json(await nextLoginStep(t.sub, false));
});

/**
 * POST /auth/2fa/setup — 인증 앱에 넣을 키를 만든다.
 *
 * 이미 등록한 계정은 여기서 다시 등록할 수 없다. 이 길이 열려 있으면
 * 비밀번호만 아는 사람이 자기 폰으로 2단계를 갈아 끼운다. 다시 등록하려면
 * 사이트 관리자가 초기화해야 한다.
 */
router.post("/2fa/setup", async (req, res) => {
  const t = readLoginTicket(req.body?.ticket);
  if (t == null || t.pwWeak) {
    res.status(401).json(TICKET_EXPIRED);
    return;
  }
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: t.sub },
    select: { totp_enabled_at: true, email: true, password_auth: { select: { username: true } } },
  });
  if (user.totp_enabled_at != null) {
    res.status(409).json({ message: "Two-factor authentication is already set up." });
    return;
  }
  const secret = newTotpSecret();
  await prisma.user.update({
    where: { id: t.sub },
    data: { totp_pending_secret: Buffer.from(await encryptSymmetric(secret)) },
  });
  const account = user.password_auth?.username ?? user.email ?? "account";
  res.json({ secret, otpauthUrl: otpauthUrl(secret, account) });
});

/** POST /auth/2fa/setup/confirm — 인증 앱의 첫 코드가 맞으면 등록을 마치고 로그인시킨다. */
router.post("/2fa/setup/confirm", async (req, res) => {
  const t = readLoginTicket(req.body?.ticket);
  const code = String(req.body?.code ?? "").replace(/\s/g, "");
  if (t == null || t.pwWeak) {
    res.status(401).json(TICKET_EXPIRED);
    return;
  }
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: t.sub },
    select: { totp_enabled_at: true, totp_pending_secret: true },
  });
  if (user.totp_enabled_at != null || user.totp_pending_secret == null) {
    res.status(409).json({ message: "Start the setup again." });
    return;
  }
  const secret = await decryptSymmetric(user.totp_pending_secret);
  const step = verifyTotp(secret, code, null);
  if (step == null) {
    res.status(401).json({ message: "The code is not correct. Check the time on your phone and try again." });
    return;
  }
  const backupCodes = newBackupCodes();
  // 아직 등록 전일 때만 바꾼다. 두 창에서 동시에 등록을 마치는 경우를 막는다.
  const { count } = await prisma.user.updateMany({
    where: { id: t.sub, totp_enabled_at: null },
    data: {
      totp_secret: user.totp_pending_secret,
      totp_pending_secret: null,
      totp_enabled_at: new Date(),
      totp_last_step: step,
      totp_backup_hashes: backupCodes.map(hashBackupCode),
    },
  });
  if (count === 0) {
    res.status(409).json({ message: "Two-factor authentication is already set up." });
    return;
  }
  const session = await generateSession(t.sub);
  const enabled = await prisma.user.findUniqueOrThrow({
    where: { id: t.sub },
    select: { totp_enabled_at: true },
  });
  res.json({
    ...session,
    backupCodes,
    deviceToken:
      req.body?.rememberDevice === true
        ? signDeviceToken(t.sub, enabled.totp_enabled_at!)
        : null,
  });
});

/**
 * POST /auth/2fa/verify — 인증 앱 코드(6자리) 또는 백업 코드로 로그인을 마친다.
 *
 * 둘 다 "조건이 맞을 때만 고친다"는 한 줄의 UPDATE 로 처리한다. 읽고 나서
 * 따로 쓰면, 같은 코드를 동시에 두 번 보냈을 때 둘 다 통과한다.
 */
router.post("/2fa/verify", async (req, res) => {
  const t = readLoginTicket(req.body?.ticket);
  const code = String(req.body?.code ?? "").trim();
  if (t == null || t.pwWeak) {
    res.status(401).json(TICKET_EXPIRED);
    return;
  }
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: t.sub },
    select: { totp_secret: true, totp_last_step: true, totp_enabled_at: true },
  });
  if (user.totp_secret == null || user.totp_enabled_at == null) {
    res.status(409).json({ message: "Two-factor authentication is not set up." });
    return;
  }

  let ok = false;
  let backupCodesLeft: number | null = null;
  if (/^\d{6}$/.test(code.replace(/\s/g, ""))) {
    const secret = await decryptSymmetric(user.totp_secret);
    const step = verifyTotp(secret, code.replace(/\s/g, ""), user.totp_last_step);
    if (step != null) {
      const n = await prisma.$executeRaw`
        UPDATE "user" SET totp_last_step = ${step}
        WHERE id = ${t.sub}::uuid AND (totp_last_step IS NULL OR totp_last_step < ${step})`;
      ok = n === 1;
    }
  } else {
    const h = hashBackupCode(code);
    const rows = await prisma.$queryRaw<{ left: number }[]>`
      UPDATE "user" SET totp_backup_hashes = array_remove(totp_backup_hashes, ${h})
      WHERE id = ${t.sub}::uuid AND ${h} = ANY(totp_backup_hashes)
      RETURNING cardinality(totp_backup_hashes) AS "left"`;
    if (rows.length === 1) {
      ok = true;
      backupCodesLeft = Number(rows[0].left);
    }
  }
  if (!ok) {
    res.status(401).json({ message: "The code is not correct." });
    return;
  }
  const session = await generateSession(t.sub);
  res.json({
    ...session,
    backupCodesLeft,
    deviceToken:
      req.body?.rememberDevice === true ? signDeviceToken(t.sub, user.totp_enabled_at) : null,
  });
});

/**
 * POST /auth/admin/users/:userId/2fa/reset — 폰과 백업 코드를 모두 잃은 사람.
 * 사이트 관리자만. 그 사람의 세션도 모두 끊고, 다음 로그인 때 다시 등록한다.
 */
router.post("/admin/users/:userId/2fa/reset", loginRequired, async (req, res) => {
  const me = await prisma.user.findUnique({
    where: { id: req.authSession!.user_id },
    select: { is_site_admin: true },
  });
  if (!me?.is_site_admin) {
    res.sendStatus(403);
    return;
  }
  const userId = String(req.params.userId);
  const { count } = await prisma.user.updateMany({
    where: { id: userId },
    data: {
      totp_secret: null,
      totp_pending_secret: null,
      totp_enabled_at: null,
      totp_last_step: null,
      totp_backup_hashes: [],
    },
  });
  if (count === 0) {
    res.sendStatus(404);
    return;
  }
  await clearSession(userId);
  console.log(`2fa reset: user ${userId} by admin ${req.authSession!.user_id}`);
  res.sendStatus(200);
});

/* ------------------------------------------------------------------ *
 * 비밀번호 찾기(이메일 인증번호)                                         *
 *                                                                    *
 * 앱(myodoc)과 같은 인증번호 장치를 쓰되 쓰임(web_reset)을 나눈다.        *
 * 계정이 있는지는 알려주지 않는다 - 병원 계정 목록을 캐는 데 쓰일 수 있다.  *
 * 재설정해도 2단계 인증은 그대로라, 메일만 털려서는 들어올 수 없다.         *
 * ------------------------------------------------------------------ */

const emailSchema = zod.string().email();

router.post("/password/send-code", async (req, res) => {
  const parsed = emailSchema.safeParse(req.body?.email);
  if (!parsed.success) {
    res.status(400).json({ message: "Enter a valid email address." });
    return;
  }
  const email = parsed.data.toLowerCase();
  const user = await prisma.user.findUnique({
    where: { email },
    select: { password_auth: { select: { user_id: true } } },
  });
  if (user?.password_auth != null) {
    try {
      await issueCode(email, "web_reset");
    } catch (e) {
      if (e instanceof VerificationError && e.code === "cooldown") {
        res.status(429).json({ message: e.message });
        return;
      }
      if (e instanceof VerificationError && e.code === "unavailable") {
        res.status(503).json({ message: "Email is not available right now. Please try again later." });
        return;
      }
      throw e;
    }
  }
  res.status(202).json({ ok: true });
});

router.post("/password/verify-code", async (req, res) => {
  const email = emailSchema.safeParse(req.body?.email);
  const code = req.body?.code;
  if (!email.success || typeof code !== "string") {
    res.sendStatus(400);
    return;
  }
  try {
    const ticket = await verifyCode(email.data, code.trim(), "web_reset");
    res.json({ ticket });
  } catch (e) {
    if (e instanceof VerificationError) {
      res.status(400).json({ message: e.message });
      return;
    }
    throw e;
  }
});

router.post("/password/reset", async (req, res) => {
  const email = emailSchema.safeParse(req.body?.email);
  const { ticket, password } = req.body ?? {};
  if (!email.success || typeof ticket !== "string" || typeof password !== "string") {
    res.sendStatus(400);
    return;
  }
  try {
    assertTicket(ticket, email.data, "web_reset");
  } catch (e) {
    if (e instanceof VerificationError) {
      res.status(400).json({ message: e.message });
      return;
    }
    throw e;
  }
  const policy = passwordPolicyError(password);
  if (policy) {
    res.status(400).json({ message: policy });
    return;
  }
  const user = await prisma.user.findUnique({
    where: { email: email.data.toLowerCase() },
    select: { id: true, password_auth: { select: { user_id: true } } },
  });
  if (user?.password_auth == null) {
    res.status(400).json({ message: "This account cannot reset a password." });
    return;
  }
  await prisma.password_auth.update({
    where: { user_id: user.id },
    data: { hash: await bcrypt.hash(password, 12) },
  });
  // 비밀번호를 찾는 이유의 절반은 남이 들어와 있을지 모른다는 걱정이다.
  await clearSession(user.id);
  res.json({ ok: true });
});

router.get("/logout", loginRequired, async (req, res) => {
  await prisma.session.delete({
    where: {
      id: req.authSession!.id,
    },
  });
  res.sendStatus(200);
});

router.get("/user", loginRequired, async (req, res) => {
  const data = await prisma.user.findUnique({
    where: {
      id: req.authSession!.user_id,
    },
    select: {
      healthcare_professional: {
        include: {
          hospital: true,
          country: true,
        },
      },
      normal_user: true,
      password_auth: {
        select: {
          username: true,
        },
      },
      google_auth: {
        select: {
          google_identity: true,
        },
      },
      id: true,
      is_site_admin: true,
      email: true,
      receive_email_updates: true,
    },
  });

  // needs_consent: true if the user is missing any REQUIRED consent
  // (terms / privacy) at the current document version. Used to prompt
  // existing users (who signed up before consent existed) to re-consent.
  const requiredTypes = ["terms_of_service", "privacy_policy"] as const;
  const agreedRequired = await prisma.user_consent.findMany({
    where: {
      user_id: req.authSession!.user_id,
      version: CONSENT_VERSION,
      agreed: true,
      consent_type: { in: [...requiredTypes] },
    },
    select: { consent_type: true },
  });
  const agreedSet = new Set(
    agreedRequired.map((c: { consent_type: string }) => c.consent_type),
  );
  const needs_consent = requiredTypes.some((t) => !agreedSet.has(t));

  res.json({ ...data, needs_consent });
});

// Existing-user (re)consent. The signup flow already records consent, but
// users created before consent existed — or before a policy revision —
// agree here. zod.literal(true) enforces the required boxes server-side.
const consentSubmitType = zod.object({
  agree_terms: zod.literal(true),
  agree_privacy: zod.literal(true),
  agree_marketing: zod.boolean().optional(),
});

router.post(
  "/consent",
  loginRequired,
  validateRequestBody(consentSubmitType),
  async (req, res) => {
    const data = req.body as zod.infer<typeof consentSubmitType>;
    const userId = req.authSession!.user_id;
    const agreeMarketing = data.agree_marketing ?? false;

    await prisma.$transaction(async (tx) => {
      // Replace any existing rows at the current version so re-submitting
      // is idempotent (no duplicate audit rows for the same version).
      await tx.user_consent.deleteMany({
        where: { user_id: userId, version: CONSENT_VERSION },
      });
      await tx.user_consent.createMany({
        data: consentRows(CONSENT_VERSION, agreeMarketing).map((row) => ({
          ...row,
          user_id: userId,
        })),
      });
      await tx.user.update({
        where: { id: userId },
        data: { receive_email_updates: agreeMarketing },
      });
    });

    res.sendStatus(200);
  },
);

const userPatchType = zod.object({
  email: zod.string().email().optional(),
  receive_email_updates: zod.boolean().optional(),
});

router.patch(
  "/user",
  loginRequired,
  validateRequestBody(userPatchType),
  async (req, res) => {
    const data = req.body as zod.infer<typeof userPatchType>;

    const { email, receive_email_updates } = data;

    await prisma.user.update({
      where: {
        id: req.authSession!.user_id,
      },
      data: {
        email: email,
        receive_email_updates: receive_email_updates,
      },
    });

    res.sendStatus(200);
  },
);

const passwordAuthType = zod.object({
  username: zod
    .string()
    .nonempty()
    .regex(/^[a-zA-Z0-9]+$/),
  password: zod.string().nonempty(),
  email: zod.string().email(),
  receive_email_updates: zod.boolean().optional(),
});

// Signup variant: requires explicit agreement to the mandatory consents
// (이용약관 + 개인정보 수집·이용). `agree_marketing` is optional (선택).
// zod.literal(true) rejects signup at the API level if a required box is
// unchecked, so consent cannot be bypassed by a tampered client.
const signupPasswordAuthType = passwordAuthType.extend({
  agree_terms: zod.literal(true),
  agree_privacy: zod.literal(true),
  agree_marketing: zod.boolean().optional(),
});

router.post(
  "/user/passwordAuth",
  validateRequestBody(signupPasswordAuthType),
  async (req, res) => {
    const data = req.body as zod.infer<typeof signupPasswordAuthType>;

    const { username, password, email, agree_marketing } = data;
    const policy = passwordPolicyError(password);
    if (policy) {
      res.status(400).json({ message: policy });
      return;
    }
    const receive_email_updates = agree_marketing ?? false;

    const hash = await bcrypt.hash(password, 12);

    await prisma.user
      .create({
        data: {
          password_auth: {
            create: {
              username: username,
              hash: hash,
            },
          },
          email: email,
          receive_email_updates: receive_email_updates,
          user_consent: {
            create: consentRows(CONSENT_VERSION, receive_email_updates),
          },
        },
      })
      .then(() => res.sendStatus(201))
      .catch((err) => {
        if (
          err instanceof PrismaClientKnownRequestError &&
          err.code === "P2002"
        ) {
          res.status(400).json({ message: "Username already exists" });
        } else {
          res.sendStatus(500);
        }
      });
  },
);

router.post(
  "/passwordAuth",
  loginRequired,
  validateRequestBody(passwordAuthType),
  async (req, res) => {
    const data = req.body as zod.infer<typeof passwordAuthType>;

    const { username, password } = data;
    const policy = passwordPolicyError(password);
    if (policy) {
      res.status(400).json({ message: policy });
      return;
    }
    const hash = await bcrypt.hash(password, 12);

    const passwordAuthExists = await prisma.password_auth
      .count({
        where: {
          user_id: req.authSession!.user_id,
        },
      })
      .then((count) => count > 0);

    if (passwordAuthExists) {
      res.status(400).json({ message: "Password auth already exists" });
      return;
    }

    await prisma.password_auth
      .create({
        data: {
          user: {
            connect: {
              id: req.authSession!.user_id,
            },
          },
          username: username,
          hash: hash,
        },
      })
      .then(() => res.sendStatus(201))
      .catch((err) => {
        if (
          err instanceof PrismaClientKnownRequestError &&
          err.code === "P2002"
        ) {
          res.status(400).json({ message: "Username already exists" });
        } else {
          res.sendStatus(500);
        }
      });
  },
);

const passwordAuthPatchType = zod.object({
  newPassword: zod.string(),
});

router.patch("/user/passwordAuth", loginRequired, async (req, res) => {
  const authSession = await getAuthSession(req);
  if (authSession == null) {
    res.sendStatus(401);
    return;
  }

  let data;
  try {
    data = passwordAuthPatchType.parse(req.body);
  } catch {
    res.sendStatus(400);
    return;
  }

  const user = await prisma.user.findUnique({
    where: {
      id: authSession.user_id,
    },
    include: {
      password_auth: true,
    },
  });

  if (user == null) {
    res.sendStatus(500);
    return;
  }

  if (user.password_auth == null) {
    res.sendStatus(400);
    return;
  }

  const policy = passwordPolicyError(data.newPassword);
  if (policy) {
    res.status(400).json({ message: policy });
    return;
  }
  const hash = await bcrypt.hash(data.newPassword, 12);

  prisma.password_auth
    .update({
      where: {
        user_id: authSession.user_id,
      },
      data: {
        hash: hash,
      },
    })
    .then(() => res.sendStatus(200));
});

const googleAuthType = zod.object({
  token: zod.string().nonempty(),
  receive_email_updates: zod.boolean().optional(),
});

// Signup via Google must also carry the mandatory consents.
const signupGoogleAuthType = googleAuthType.extend({
  agree_terms: zod.literal(true),
  agree_privacy: zod.literal(true),
  agree_marketing: zod.boolean().optional(),
});

router.post(
  "/user/googleAuth",
  validateRequestBody(signupGoogleAuthType),
  async (req, res) => {
    const data = req.body as zod.infer<typeof signupGoogleAuthType>;

    const { token, agree_marketing } = data;
    const receive_email_updates = agree_marketing ?? false;

    const ticket = await client.verifyIdToken({
      idToken: token,
      audience: process.env.GOOGLE_CLIENT_ID,
    });

    const payload = ticket.getPayload();
    if (payload == null) {
      res.sendStatus(400);
      return;
    }

    const email = payload.email;
    console.log(email);
    if (email == null) {
      res.sendStatus(400);
      return;
    }

    await prisma.user
      .create({
        data: {
          google_auth: {
            create: {
              google_identity: payload.sub,
            },
          },
          email: payload.email,
          receive_email_updates: receive_email_updates,
          user_consent: {
            create: consentRows(CONSENT_VERSION, receive_email_updates),
          },
        },
      })
      .then(() => res.sendStatus(201))
      .catch((err) => {
        if (
          err instanceof PrismaClientKnownRequestError &&
          err.code === "P2002"
        ) {
          res.status(400).json({
            message: "The google account is already associated with an account",
          });
        } else {
          res.sendStatus(500);
        }
      });
  },
);

router.post("/googleAuth", loginRequired, async (req, res) => {
  const token = req.body.token;
  if (typeof token !== "string" || !token) {
    res.sendStatus(400);
    return;
  }

  const ticket = await client.verifyIdToken({
    idToken: token,
    audience: process.env.GOOGLE_CLIENT_ID,
  });

  const payload = ticket.getPayload();
  if (payload == null) {
    res.sendStatus(401);
    return;
  }

  const googleAuthExists = await prisma.google_auth
    .count({
      where: {
        user_id: req.authSession!.user_id,
      },
    })
    .then((count) => count > 0);

  if (googleAuthExists) {
    res.status(400).json({ message: "Google auth already exists" });
    return;
  }

  await prisma.google_auth
    .create({
      data: {
        user: {
          connect: {
            id: req.authSession!.user_id,
          },
        },
        google_identity: payload.sub,
      },
    })
    .catch((err) => {
      if (
        err instanceof PrismaClientKnownRequestError &&
        err.code === "P2002"
      ) {
        res.status(400).json({
          message: "The google account is already associated with an account",
        });
      } else {
        res.sendStatus(500);
      }
    })
    .then(() => res.sendStatus(201));
});

router.delete("/googleAuth", loginRequired, async (req, res) => {
  const passwordAuthExists = await prisma.password_auth
    .count({
      where: {
        user_id: req.authSession!.user_id,
      },
    })
    .then((count) => count > 0);
  if (!passwordAuthExists) {
    res
      .status(400)
      .json({ message: "You have to keep at least one authentication method" });
    return;
  }
  await prisma.google_auth
    .delete({
      where: {
        user_id: req.authSession!.user_id,
      },
    })
    .then(() => res.sendStatus(200));
});

router.delete("/passwordAuth", loginRequired, async (req, res) => {
  const googleAuthExists = await prisma.google_auth
    .count({
      where: {
        user_id: req.authSession!.user_id,
      },
    })
    .then((count) => count > 0);
  if (!googleAuthExists) {
    res
      .status(400)
      .json({ message: "You have to keep at least one authentication method" });
    return;
  }
  await prisma.password_auth
    .delete({
      where: {
        user_id: req.authSession!.user_id,
      },
    })
    .then(() => res.sendStatus(200));
});

router.delete("/user", loginRequired, async (req, res) => {
  await prisma.user
    .delete({
      where: {
        id: req.authSession!.user_id,
      },
    })
    .then(() => res.sendStatus(200));
});

router.post("/dev_login", async (req, res) => {
  // Local-development helper only. Never expose in production: it issues an
  // approved admin session without real credentials.
  if (process.env.NODE_ENV === "production") {
    res.sendStatus(404);
    return;
  }

  // 1. Ensure Default Country exists
  let country = await prisma.country.findFirst({ where: { code: "US" } });
  if (!country) {
    country = await prisma.country.create({
      data: { name: "United States", code: "US" },
    });
  }

  // 2. Ensure Default Hospital exists
  let hospital = await prisma.hospital.findFirst({
    where: { name: "Dev Hospital" },
  });
  if (!hospital) {
    hospital = await prisma.hospital.create({
      data: {
        name: "Dev Hospital",
        code: "DEV001",
        country_id: country.id,
      },
    });
  }

  // 3. Find or Create Dev User
  // Check password_auth for 'devuser'
  let auth = await prisma.password_auth.findUnique({
    where: { username: "devuser" },
    include: { user: true },
  });

  let user;

  if (!auth) {
    // Create everything
    const hash = await bcrypt.hash("devpassword", 10);
    user = await prisma.user.create({
      data: {
        password_auth: {
          create: {
            username: "devuser",
            hash: hash,
          },
        },
        healthcare_professional: {
          create: {
            name: "Dev Doctor",
            role: "Ophthalmologist",
            country_id: country.id,
            hospital_id: hospital.id,
            approved: true, // Auto approve
            is_admin: true,
          },
        },
      },
    });
  } else {
    user = auth.user;
  }

  // 4. Generate Session
  generateSession(user.id)
    .then((session) => res.json(session))
    .catch((e) => {
      console.error(e);
      res.sendStatus(500);
    });
});

export default router;
