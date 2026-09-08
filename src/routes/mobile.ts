import express from "express";
import fs from "fs";
import path from "path";
import bcrypt from "bcrypt";
import zod from "zod";
import { PrismaClientKnownRequestError } from "@prisma/client/runtime/library";
import { Prisma, sex as SexEnum, myopia_status as MyopiaStatusEnum } from "@prisma/client";

import prisma from "../lib/prisma";
import { resolveInvite } from "../services/linkInvite";
import { validateRequestBody } from "../lib/middlewares";
import {
  issueRefreshToken,
  rotateRefreshToken,
  requireMobileAuth,
  optionalMobileAuth,
  revokeAllRefreshTokens,
  signAccessToken,
  MobileJWTPayload,
} from "../lib/mobileAuth";
import { verifySocialToken, SocialProvider } from "../lib/socialAuth";
import {
  assertTicket,
  issueCode,
  verifyCode,
  VerificationError,
} from "../services/emailVerification";
import { decryptSymmetric } from "../services/encrpytion";
import { hashRegistrationNumber } from "../lib/hash";
import { authorBlockFilter } from "../lib/blocks";
import { notify } from "../lib/notify";
import { hotScore, popularSince } from "../lib/ranking";
import { toDistrictAddress } from "../lib/kakaoPlaces";
import { CONSENT_VERSION } from "../lib/consent";

/**
 * Mobile API — mounted at /api/mobile in src/index.ts.
 *
 * Notes on the data model used here:
 *   - An "app user" is any user row that has a corresponding normal_user
 *     row. We ensure that row exists on signup / first social login so
 *     the role check is consistent.
 *   - "Children" are parent_child_link rows owned by the user.
 *   - "Hospital links" are child_hospital_link rows connecting a child
 *     profile to a real hospital patient record. Deleting a child only
 *     deletes the link rows — the hospital's patient + measurements stay.
 *   - Hospital linking verifies registration_number via the existing
 *     hash column and verifies date_of_birth by KMS-decrypting the
 *     stored ciphertext.
 */

const router = express.Router();

/* ------------------------------------------------------------------ *
 * Helpers                                                             *
 * ------------------------------------------------------------------ */

const REGULAR_ROLE = "regular_user" as const;

async function ensureNormalUser(userId: string): Promise<void> {
  await prisma.normal_user.upsert({
    where: { user_id: userId },
    update: {},
    create: { user_id: userId },
  });
}

type UserDTO = {
  id: string;
  username: string | null;
  email: string | null;
  role: "regular_user";
  createdAt: string;
  /** 이 계정으로 로그인하는 방법. 소셜로 시작하면 아이디·비밀번호가 없다. */
  authMethods: ("password" | "apple" | "google" | "kakao" | "naver")[];
  receiveEmailUpdates: boolean;
};

/**
 * 이메일은 저장·조회 모두 소문자로 맞춘다.
 *
 * 유니크 인덱스는 대소문자를 구분해서, 정규화하지 않으면 A@b.com 과
 * a@b.com 이 서로 다른 계정이 된다. 그러면 비밀번호 재설정이 계정을
 * 찾지 못하고, 중복을 막으려고 건 제약도 그냥 비켜간다.
 */
function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

async function userDTO(userId: string): Promise<UserDTO | null> {
  const u = await prisma.user.findUnique({
    where: { id: userId },
    include: { password_auth: true, oauth_identity: true },
  });
  if (u == null) return null;
  const authMethods: UserDTO["authMethods"] = [];
  if (u.password_auth != null) authMethods.push("password");
  for (const o of u.oauth_identity) {
    authMethods.push(o.provider as "apple" | "google" | "kakao" | "naver");
  }
  return {
    id: u.id,
    username: u.password_auth?.username ?? null,
    email: u.email,
    role: REGULAR_ROLE,
    createdAt: u.created_at.toISOString(),
    authMethods,
    receiveEmailUpdates: u.receive_email_updates,
  };
}

async function issueAuthResponse(userId: string) {
  const { token, expiresIn } = signAccessToken({
    sub: userId,
    role: REGULAR_ROLE,
  });
  const refreshToken = await issueRefreshToken(userId);
  const user = await userDTO(userId);
  return {
    user,
    accessToken: token,
    refreshToken,
    accessTokenExpiresIn: expiresIn,
  };
}

function requireAppUser(req: express.Request): MobileJWTPayload {
  // Cast is safe: requireMobileAuth has already populated this.
  return req.mobileUser!;
}

/**
 * Discriminated union representing the two ways a child can be associated
 * with the requesting parent user:
 *
 *   - "app"  → a row in `parent_child_link` (created via the iOS app's
 *              "add child" flow). Has a nickname/DOB/sex and may be
 *              connected to multiple hospitals via child_hospital_link.
 *   - "web"  → a row in `user_patient` (created via the existing
 *              myopiamanage.org "register child" flow on the web). Has
 *              a single linked patient row (1 hospital).
 *
 * The `childId` is the unique identifier the iOS app exposes externally:
 *   - for app-source: parent_child_link.id
 *   - for web-source: patient.id
 * UUIDs are globally unique so no namespace collision is possible.
 */
type OwnedChild =
  | { source: "app"; childId: string; userId: string; appLink: { id: string; user_id: string; nickname: string; name: string | null; date_of_birth: Date; sex: SexEnum } }
  | { source: "web"; childId: string; userId: string; patientId: string };

/**
 * Resolves a childId for the requesting user, transparently looking in
 * both `parent_child_link` (app-source) and `user_patient` (web-source).
 * Returns null if no match was found or the child does not belong to
 * the user.
 */
async function findOwnedChild(
  childId: string,
  userId: string,
): Promise<OwnedChild | null> {
  // 1) App-source: parent_child_link
  const appLink = await prisma.parent_child_link.findUnique({
    where: { id: childId },
  });
  if (appLink != null && appLink.user_id === userId) {
    return { source: "app", childId: appLink.id, userId, appLink };
  }
  // 2) Web-source: user_patient (myopiamanage.org "register child")
  const userPatient = await prisma.user_patient.findUnique({
    where: { user_id_patient_id: { user_id: userId, patient_id: childId } },
  });
  if (userPatient != null) {
    return { source: "web", childId, userId, patientId: childId };
  }
  return null;
}

/** Compatibility shim — keep the old name working while we migrate
 *  call sites. Returns the underlying `parent_child_link` row for app
 *  sources and `null` for web sources. New code should use
 *  `findOwnedChild` directly.
 */
async function loadOwnedChild(userId: string, childId: string) {
  const owned = await findOwnedChild(childId, userId);
  if (owned == null) return null;
  if (owned.source !== "app") return null;
  return owned.appLink;
}
async function getOwnedChild(childId: string, userId: string) {
  return loadOwnedChild(userId, childId);
}

/**
 * Returns the patient ids for every hospital that a given child is
 * linked to, regardless of source.
 *
 *   - app-source children fan out across `child_hospital_link` rows
 *     (status: active).
 *   - web-source children resolve to the single linked patient (the
 *     1:1 mapping enforced by the web's user_patient flow).
 */
async function linkedPatientIds(childOrId: OwnedChild | string): Promise<
  { patientId: string; hospitalId: string; hospitalName: string }[]
> {
  // Backwards-compat: callers that passed a raw childId continue to
  // work as if it's an app-source child (which was the only case the
  // old signature supported).
  if (typeof childOrId === "string") {
    const links = await prisma.child_hospital_link.findMany({
      where: { parent_child_link_id: childOrId, status: "active" },
      include: { hospital: { select: { id: true, name: true } } },
    });
    return links.map((l) => ({
      patientId: l.patient_id,
      hospitalId: l.hospital_id,
      hospitalName: l.hospital.name,
    }));
  }

  if (childOrId.source === "web") {
    const patient = await prisma.patient.findUnique({
      where: { id: childOrId.patientId },
      include: { hospital: { select: { id: true, name: true } } },
    });
    if (patient == null) return [];
    return [
      {
        patientId: patient.id,
        hospitalId: patient.hospital_id,
        hospitalName: patient.hospital.name,
      },
    ];
  }

  // app-source
  const links = await prisma.child_hospital_link.findMany({
    where: { parent_child_link_id: childOrId.childId, status: "active" },
    include: { hospital: { select: { id: true, name: true } } },
  });
  return links.map((l) => ({
    patientId: l.patient_id,
    hospitalId: l.hospital_id,
    hospitalName: l.hospital.name,
  }));
}

/* ------------------------------------------------------------------ *
 * Auth                                                                *
 * ------------------------------------------------------------------ */

const signupSchema = zod.object({
  username: zod
    .string()
    .nonempty()
    .regex(/^[a-zA-Z0-9]+$/),
  password: zod.string().min(8),
  email: zod.string().email(),
  /** /auth/email/verify-code 가 준 티켓. 이게 없으면 가입이 끝나지 않는다. */
  verificationTicket: zod.string().nonempty(),
  receive_email_updates: zod.boolean().optional(),
});

/**
 * GET /api/mobile/auth/username-available?username=...
 *
 * 가입 버튼을 눌러야 중복을 알 수 있었다. 아이디를 정하고 이메일 인증까지
 * 마친 뒤에 거절당하면, 사용자는 어느 칸이 문제인지 모른 채 처음으로 돌아간다.
 *
 * 아이디가 쓰이는지 알려주는 것은 곧 그 아이디의 존재를 알려주는 것이다.
 * 다만 가입 시도로도 같은 사실이 드러나고, 아이디만으로는 로그인할 수 없다.
 * 감춰서 얻는 것보다 입력 중에 알려주는 편이 낫다고 봤다.
 */
router.get("/auth/username-available", async (req, res) => {
  const username = String(req.query.username ?? "").trim();
  if (!/^[a-zA-Z0-9]{1,}$/.test(username)) {
    res.status(400).json({ error: "invalid username", code: "validation_error" });
    return;
  }
  const taken = await prisma.password_auth.findUnique({ where: { username } });
  res.json({ available: taken == null });
});

const sendCodeSchema = zod.object({ email: zod.string().email() });

/** POST /api/mobile/auth/email/send-code — 인증번호 발송. */
router.post(
  "/auth/email/send-code",
  validateRequestBody(sendCodeSchema),
  async (req, res) => {
    const { email } = req.body as zod.infer<typeof sendCodeSchema>;
    // 이미 가입된 주소인지 여기서 알려준다. 코드를 받고 다 입력한 뒤
    // 마지막에 "이미 가입됨"을 보는 것보다 낫다.
    const taken = await prisma.user.findUnique({
      where: { email: normalizeEmail(email) },
    });
    if (taken != null) {
      res
        .status(409)
        .json({ error: "이미 가입된 이메일입니다.", code: "conflict" });
      return;
    }
    try {
      await issueCode(email, "signup");
      res.status(202).json({ ok: true });
    } catch (e) {
      if (e instanceof VerificationError) {
        res.status(429).json({ error: e.message, code: e.code });
        return;
      }
      throw e;
    }
  },
);

const verifyCodeSchema = zod.object({
  email: zod.string().email(),
  code: zod.string().regex(/^[0-9]{6}$/),
});

/** POST /api/mobile/auth/email/verify-code — 확인 후 가입용 티켓 발급. */
router.post(
  "/auth/email/verify-code",
  validateRequestBody(verifyCodeSchema),
  async (req, res) => {
    const { email, code } = req.body as zod.infer<typeof verifyCodeSchema>;
    try {
      const ticket = await verifyCode(email, code, "signup");
      res.json({ verificationTicket: ticket });
    } catch (e) {
      if (e instanceof VerificationError) {
        res.status(400).json({ error: e.message, code: e.code });
        return;
      }
      throw e;
    }
  },
);

router.post(
  "/auth/signup",
  validateRequestBody(signupSchema),
  async (req, res) => {
    const data = req.body as zod.infer<typeof signupSchema>;
    try {
      assertTicket(data.verificationTicket, data.email, "signup");
    } catch (e) {
      if (e instanceof VerificationError) {
        res.status(400).json({ error: e.message, code: "validation_error" });
        return;
      }
      throw e;
    }
    const hash = await bcrypt.hash(data.password, 12);

    try {
      const user = await prisma.user.create({
        data: {
          email: normalizeEmail(data.email),
          receive_email_updates: data.receive_email_updates ?? false,
          password_auth: {
            create: {
              username: data.username,
              hash,
            },
          },
          normal_user: { create: {} },
        },
      });
      const body = await issueAuthResponse(user.id);
      res.status(201).json(body);
    } catch (e) {
      if (e instanceof PrismaClientKnownRequestError && e.code === "P2002") {
        // 아이디와 이메일 둘 다 유니크다. 어느 쪽이 걸렸는지 알려주지 않으면
        // 사용자는 멀쩡한 값을 계속 고쳐 보게 된다.
        const onEmail = (e.meta?.target as string[] | undefined)?.some((t) =>
          t.includes("email"),
        );
        res.status(400).json({
          error: onEmail
            ? "이미 가입된 이메일입니다."
            : "이미 사용 중인 아이디입니다.",
          code: "validation_error",
        });
        return;
      }
      throw e;
    }
  },
);

const loginSchema = zod.object({
  username: zod.string().nonempty(),
  password: zod.string().nonempty(),
});

router.post("/auth/login", validateRequestBody(loginSchema), async (req, res) => {
  const { username, password } = req.body as zod.infer<typeof loginSchema>;
  const auth = await prisma.password_auth.findUnique({
    where: { username },
    include: { user: true },
  });
  if (auth == null) {
    res.status(401).json({ error: "invalid credentials", code: "unauthorized" });
    return;
  }
  const ok = await bcrypt.compare(password, auth.hash);
  if (!ok) {
    res.status(401).json({ error: "invalid credentials", code: "unauthorized" });
    return;
  }
  await ensureNormalUser(auth.user.id);
  res.json(await issueAuthResponse(auth.user.id));
});

/* ------------------------------------------------------------------ *
 * 비밀번호 재설정                                                       *
 *                                                                    *
 * 계정이 있는지 없는지를 그대로 알려준다. 감추는 편이 원칙이지만,
 * 가입 쪽에서 이미 "이미 가입된 이메일입니다"로 같은 사실을 드러내고
 * 있어 여기만 감추면 얻는 것이 없다. 대신 못 찾았을 때 사용자가 오타를
 * 바로 알아챌 수 있다.
 * ------------------------------------------------------------------ */

/** POST /api/mobile/auth/password/send-code */
router.post(
  "/auth/password/send-code",
  validateRequestBody(sendCodeSchema),
  async (req, res) => {
    const { email } = req.body as zod.infer<typeof sendCodeSchema>;
    const user = await prisma.user.findUnique({
      where: { email: normalizeEmail(email) },
      include: { password_auth: true },
    });
    if (user == null) {
      res
        .status(404)
        .json({ error: "가입되지 않은 이메일입니다.", code: "not_found" });
      return;
    }
    // 소셜로만 가입하면 바꿀 비밀번호 자체가 없다. 코드를 보내봐야
    // 마지막 단계에서 막히므로 여기서 알려준다.
    if (user.password_auth == null) {
      res.status(409).json({
        error:
          "소셜 로그인으로 가입한 계정입니다. 가입할 때 사용한 방법으로 로그인해 주세요.",
        code: "conflict",
      });
      return;
    }
    try {
      await issueCode(email, "reset");
      res.status(202).json({ ok: true });
    } catch (e) {
      if (e instanceof VerificationError) {
        res.status(429).json({ error: e.message, code: e.code });
        return;
      }
      throw e;
    }
  },
);

/** POST /api/mobile/auth/password/verify-code */
router.post(
  "/auth/password/verify-code",
  validateRequestBody(verifyCodeSchema),
  async (req, res) => {
    const { email, code } = req.body as zod.infer<typeof verifyCodeSchema>;
    try {
      const verificationTicket = await verifyCode(email, code, "reset");
      // 아이디 찾기를 따로 만들지 않는다. 이 주소의 주인임을 방금 증명했으니
      // 아이디를 알려줘도 되고, 비밀번호를 잊은 사람은 아이디도 같이 잊는다.
      // 소셜로만 가입한 계정은 아이디가 없어 null 이 되고, 화면은 그때
      // 아이디 칸을 그리지 않는다.
      const user = await prisma.user.findUnique({
        where: { email: normalizeEmail(email) },
        include: { password_auth: true },
      });
      res.json({
        verificationTicket,
        username: user?.password_auth?.username ?? null,
      });
    } catch (e) {
      if (e instanceof VerificationError) {
        res.status(400).json({ error: e.message, code: e.code });
        return;
      }
      throw e;
    }
  },
);

const resetSchema = zod.object({
  email: zod.string().email(),
  verificationTicket: zod.string().nonempty(),
  password: zod.string().min(8),
});

/** POST /api/mobile/auth/password/reset */
router.post(
  "/auth/password/reset",
  validateRequestBody(resetSchema),
  async (req, res) => {
    const d = req.body as zod.infer<typeof resetSchema>;
    try {
      assertTicket(d.verificationTicket, d.email, "reset");
    } catch (e) {
      if (e instanceof VerificationError) {
        res.status(400).json({ error: e.message, code: "validation_error" });
        return;
      }
      throw e;
    }
    const user = await prisma.user.findUnique({
      where: { email: normalizeEmail(d.email) },
      include: { password_auth: true },
    });
    if (user?.password_auth == null) {
      res
        .status(404)
        .json({ error: "가입되지 않은 이메일입니다.", code: "not_found" });
      return;
    }
    await prisma.password_auth.update({
      where: { user_id: user.id },
      data: { hash: await bcrypt.hash(d.password, 12) },
    });
    // 비밀번호를 바꾸는 이유의 절반은 남이 들어와 있을지 모른다는 걱정이다.
    // 기존 세션을 그대로 두면 그 걱정이 해결되지 않는다.
    await revokeAllRefreshTokens(user.id);
    res.json({ ok: true });
  },
);

const socialSchema = zod.object({
  provider: zod.enum(["apple", "google", "kakao", "naver"]),
  token: zod.string().nonempty(),
  email: zod.string().email().optional(),
  receive_email_updates: zod.boolean().optional(),
});

router.post(
  "/auth/social",
  validateRequestBody(socialSchema),
  async (req, res) => {
    const body = req.body as zod.infer<typeof socialSchema>;
    let identity;
    try {
      identity = await verifySocialToken(
        body.provider as SocialProvider,
        body.token,
      );
    } catch (e) {
      res
        .status(401)
        .json({ error: "provider token rejected", code: "unauthorized" });
      return;
    }

    // Find-or-create user via oauth_identity(provider, subject).
    const existing = await prisma.oauth_identity.findUnique({
      where: {
        provider_subject: {
          provider: body.provider,
          subject: identity.subject,
        },
      },
    });

    let userId: string;
    if (existing) {
      userId = existing.user_id;

      // 이미 있는 계정에 이메일이 비어 있고 이번에 제공자가 주면 채운다.
      //
      // 카카오는 비즈니스 인증 전까지 이메일을 주지 않아, 그 사이에 가입한
      // 계정은 이메일이 비어 있다. 채우지 않으면 인증이 통과한 뒤에도
      // 그 계정만 영영 비어 있고, 그 사람은 아이디·비밀번호 찾기를 쓸 수
      // 없다 - 아이 기록이 쌓인 계정을 복구할 길이 없다는 뜻이다.
      //
      // 다른 계정이 이미 쓰는 주소면 건드리지 않는다. 여기서 계정을 합치는
      // 것은 로그인 요청이 할 일이 아니고, 잘못 합치면 되돌릴 수 없다.
      const providerEmail =
        identity.email != null ? normalizeEmail(identity.email) : null;
      if (providerEmail != null) {
        const me = await prisma.user.findUnique({ where: { id: userId } });
        if (me != null && me.email == null) {
          const taken = await prisma.user.findUnique({
            where: { email: providerEmail },
          });
          if (taken == null) {
            await prisma.user.update({
              where: { id: userId },
              data: { email: providerEmail },
            });
          }
        }
      }
    } else {
      const email =
        identity.email != null
          ? normalizeEmail(identity.email)
          : body.email != null
            ? normalizeEmail(body.email)
            : null;

      // 같은 주소로 이미 만든 계정이 있으면 그 계정에 이 로그인 방법을
      // 덧붙인다. 새로 만들면 email 유니크에 걸려 로그인 자체가 실패하고,
      // 유니크를 풀면 한 사람이 계정 두 개로 갈라져 아이 기록이 나뉜다.
      //
      // 주소가 그 사람 것이라는 근거는 제공자에게 있다 - 애플·구글·카카오·
      // 네이버 모두 자기가 확인한 주소만 내려준다.
      const sameEmail =
        email != null
          ? await prisma.user.findUnique({ where: { email } })
          : null;

      if (sameEmail != null) {
        await prisma.oauth_identity.create({
          data: {
            user_id: sameEmail.id,
            provider: body.provider,
            subject: identity.subject,
          },
        });
        userId = sameEmail.id;
      } else {
        const created = await prisma.user.create({
          data: {
            email,
            receive_email_updates: body.receive_email_updates ?? false,
            normal_user: { create: {} },
            oauth_identity: {
              create: {
                provider: body.provider,
                subject: identity.subject,
              },
            },
          },
        });
        userId = created.id;
      }
    }
    await ensureNormalUser(userId);
    res.json(await issueAuthResponse(userId));
  },
);

const refreshSchema = zod.object({ refreshToken: zod.string().nonempty() });

router.post(
  "/auth/refresh",
  validateRequestBody(refreshSchema),
  async (req, res) => {
    const { refreshToken } = req.body as zod.infer<typeof refreshSchema>;
    try {
      const { userId, newRefreshToken } = await rotateRefreshToken(refreshToken);
      const { token, expiresIn } = signAccessToken({
        sub: userId,
        role: REGULAR_ROLE,
      });
      res.json({
        accessToken: token,
        refreshToken: newRefreshToken,
        accessTokenExpiresIn: expiresIn,
      });
    } catch {
      res.status(401).json({ error: "invalid refresh", code: "unauthorized" });
    }
  },
);

router.post("/auth/logout", requireMobileAuth, async (req, res) => {
  const user = requireAppUser(req);
  await revokeAllRefreshTokens(user.sub);
  res.json({ ok: true });
});

router.get("/auth/me", requireMobileAuth, async (req, res) => {
  const user = requireAppUser(req);
  const dto = await userDTO(user.sub);
  if (dto == null) {
    res.status(404).json({ error: "user not found", code: "not_found" });
    return;
  }
  res.json(dto);
});

/**
 * DELETE /api/mobile/auth/me — 회원 탈퇴.
 *
 * 애플은 계정을 만들 수 있는 앱에 앱 안에서의 계정 삭제를 요구한다
 * (App Store Review Guideline 5.1.1(v)).
 *
 * user 행을 지우면 FK 가 CASCADE 인 것들은 따라 지워진다. 문제는 커뮤니티
 * 투표·후기·신고·차단·알림 테이블인데, 이들은 user_id 를 들고 있으면서도
 * user 로의 FK 가 없다. 그냥 user 를 지우면 지워지지 않고 남아, 탈퇴한
 * 사람의 후기 본문과 user_id 가 계속 조회된다. 그래서 먼저 손으로 지운다.
 *
 * 반대로 지우지 않는 것도 있다. patient·measurement·refractive_error 의
 * creator_id 는 SET NULL 이라 병원이 보유한 진료 기록 자체는 남는다.
 * 의무기록은 의료법에 따라 병원이 보존할 의무가 있고, 앱 탈퇴가 그 의무를
 * 없애지는 못한다.
 */
router.delete("/auth/me", requireMobileAuth, async (req, res) => {
  const user = requireAppUser(req);

  // 같은 user 테이블을 의료진 플랫폼(myopiamanage)도 쓴다. 의료진이나
  // 사이트 관리자 계정이 앱에서 지워지면 그쪽 서비스가 함께 날아간다.
  const owner = await prisma.user.findUnique({
    where: { id: user.sub },
    select: {
      is_site_admin: true,
      healthcare_professional: { select: { user_id: true } },
    },
  });
  if (owner == null) {
    res.status(404).json({ error: "user not found", code: "not_found" });
    return;
  }
  if (owner.is_site_admin || owner.healthcare_professional != null) {
    res.status(409).json({
      error: "이 계정은 앱에서 탈퇴할 수 없습니다. 관리자에게 문의해 주세요.",
      code: "not_app_account",
    });
    return;
  }

  await prisma.$transaction(async (tx) => {
    const uid = user.sub;

    // 1) user 로의 FK 가 없어 CASCADE 가 닿지 않는 것들.
    await tx.poll_comment_like.deleteMany({ where: { user_id: uid } });
    await tx.poll_comment.deleteMany({ where: { user_id: uid } });
    await tx.poll_vote.deleteMany({ where: { user_id: uid } });
    // poll 을 지우면 그 안의 선택지·투표·댓글은 poll FK 를 타고 함께 지워진다.
    await tx.poll.deleteMany({ where: { user_id: uid } });
    await tx.hospital_review.deleteMany({ where: { user_id: uid } });
    await tx.user_block.deleteMany({
      where: { OR: [{ blocker_user_id: uid }, { blocked_user_id: uid }] },
    });
    await tx.notification.deleteMany({ where: { user_id: uid } });

    // 내가 신고한 건은 지운다. 나를 신고한 건은 다른 이용자를 보호하기 위한
    // 기록이라 남기되, 누구를 가리키는지는 지운다.
    await tx.content_report.deleteMany({ where: { reporter_user_id: uid } });
    await tx.content_report.updateMany({
      where: { target_user_id: uid },
      data: { target_user_id: null },
    });
    await tx.notification.updateMany({
      where: { actor_user_id: uid },
      data: { actor_user_id: null },
    });

    // 칼럼·배너·병원 프로필의 created_by 도 FK 가 없다. 이 셋은 웹 세션에서만
    // 채워지고 위에서 의료진·관리자 계정을 막았으니 실제로는 걸릴 일이 없지만,
    // "걸릴 일이 없다"에 기대면 나중에 경로가 하나 늘 때 조용히 깨진다.
    await tx.expert_column.updateMany({
      where: { created_by: uid },
      data: { created_by: null },
    });
    await tx.ad_banner.updateMany({
      where: { created_by: uid },
      data: { created_by: null },
    });
    await tx.hospital_profile.updateMany({
      where: { created_by: uid },
      data: { created_by: null },
    });

    // 2) 나머지는 user 행을 지우면 CASCADE 로 따라 지워진다.
    //    자녀·소셜 연결·동의 이력·게시글·댓글·좋아요·토큰 등.
    await tx.user.delete({ where: { id: uid } });
  });

  res.json({ ok: true });
});

/* ------------------------------------------------------------------ *
 * Children                                                            *
 * ------------------------------------------------------------------ */

function serializeDateOnly(d: Date): string {
  // YYYY-MM-DD, UTC-safe for DATE columns.
  return d.toISOString().slice(0, 10);
}

router.get("/children", requireMobileAuth, async (req, res) => {
  const user = requireAppUser(req);

  // ── App-source: parent_child_link rows the user owns ──────────────
  const appChildren = await prisma.parent_child_link.findMany({
    where: { user_id: user.sub },
    orderBy: { created_at: "asc" },
    include: {
      child_hospital_link: {
        include: {
          hospital: { select: { id: true, name: true, code: true } },
          patient: {
            select: {
              id: true,
              encrypted_registration_number: true,
            },
          },
        },
      },
    },
  });

  // ── Web-source: user_patient rows from myopiamanage.org ─────────────
  // We deliberately filter to user_patient ONLY (the regular_user
  // "register child" flow). HCP-managed patients without a user_patient
  // link never reach the iOS app, even if the patient row exists.
  const webChildren = await prisma.user_patient.findMany({
    where: { user_id: user.sub },
    include: {
      patient: {
        include: {
          hospital: { select: { id: true, name: true, code: true } },
        },
      },
    },
  });

  // Patient ids already represented by an app-source child — used to
  // dedupe so the same patient doesn't appear twice when a parent has
  // both an iOS parent_child_link and a web user_patient pointing at
  // the same patient row. App-source wins (richer metadata).
  const appPatientIds = new Set<string>(
    appChildren.flatMap((c) => c.child_hospital_link.map((l) => l.patient_id)),
  );

  const appResults = await Promise.all(
    appChildren.map(async (c) => ({
      childId: c.id,
      source: "app" as const,
      nickname: c.nickname,
      name: c.name,
      dateOfBirth: serializeDateOnly(c.date_of_birth),
      sex: c.sex,
      linkedHospitals: await Promise.all(
        c.child_hospital_link.map(async (l) => ({
          hospitalId: l.hospital.id,
          hospitalName: l.hospital.name,
          hospitalCode: l.hospital.code,
          patientId: l.patient_id,
          registrationNumber: await decryptSymmetric(
            l.patient.encrypted_registration_number,
          ),
          linkedAt: l.linked_at.toISOString(),
          status: l.status,
        })),
      ),
    })),
  );

  const webResults = await Promise.all(
    webChildren
      .filter((up) => !appPatientIds.has(up.patient_id))
      .map(async (up) => {
        const p = up.patient;
        const [regNumber, dob] = await Promise.all([
          decryptSymmetric(p.encrypted_registration_number),
          decryptSymmetric(p.encrypted_date_of_birth),
        ]);
        return {
          childId: p.id,                     // patient_id used as the public child id
          source: "web" as const,
          nickname: regNumber,               // web rows have no nickname; show MRN
          dateOfBirth: dob,                  // YYYY-MM-DD
          sex: p.sex,
          linkedHospitals: [
            {
              hospitalId: p.hospital.id,
              hospitalName: p.hospital.name,
              hospitalCode: p.hospital.code,
              patientId: p.id,
              registrationNumber: regNumber,
              linkedAt: p.created_at.toISOString(),
              status: "active" as const,
            },
          ],
        };
      }),
  );

  res.json([...appResults, ...webResults]);
});

const childCreateSchema = zod.object({
  nickname: zod.string().nonempty().max(80),
  // 실명. 이 칸이 생기기 전 앱에서는 보내지 않으므로 선택으로 받는다.
  name: zod.string().trim().min(1).max(80).optional(),
  dateOfBirth: zod.string().date(),
  sex: zod.nativeEnum(SexEnum),
});

router.post(
  "/children",
  requireMobileAuth,
  validateRequestBody(childCreateSchema),
  async (req, res) => {
    const user = requireAppUser(req);
    const data = req.body as zod.infer<typeof childCreateSchema>;
    const created = await prisma.parent_child_link.create({
      data: {
        user_id: user.sub,
        nickname: data.nickname,
        name: data.name ?? null,
        date_of_birth: new Date(data.dateOfBirth),
        sex: data.sex,
      },
    });
    res.status(201).json({
      childId: created.id,
      nickname: created.nickname,
      name: created.name,
      dateOfBirth: serializeDateOnly(created.date_of_birth),
      sex: created.sex,
      linkedHospitals: [],
    });
  },
);

const childPatchSchema = zod
  .object({
    nickname: zod.string().nonempty().max(80).optional(),
    name: zod.string().trim().min(1).max(80).optional(),
    dateOfBirth: zod.string().date().optional(),
    sex: zod.nativeEnum(SexEnum).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, {
    message: "at least one field is required",
  });

router.patch(
  "/children/:childId",
  requireMobileAuth,
  validateRequestBody(childPatchSchema),
  async (req, res) => {
    const user = requireAppUser(req);
    // Looking through findOwnedChild lets us distinguish the two
    // failure modes ("doesn't exist" vs "exists but is web-source so
    // not editable here").
    const owned = await findOwnedChild(String(req.params.childId), user.sub);
    if (owned == null) {
      res.status(404).json({ error: "child not found", code: "not_found" });
      return;
    }
    if (owned.source === "web") {
      res.status(400).json({
        error: "web-source children cannot be edited from the iOS app",
        code: "validation_error",
      });
      return;
    }
    const child = owned.appLink;
    const data = req.body as zod.infer<typeof childPatchSchema>;
    const updated = await prisma.parent_child_link.update({
      where: { id: child.id },
      data: {
        nickname: data.nickname,
        name: data.name,
        date_of_birth: data.dateOfBirth ? new Date(data.dateOfBirth) : undefined,
        sex: data.sex,
      },
    });
    res.json({
      childId: updated.id,
      nickname: updated.nickname,
      name: updated.name,
      dateOfBirth: serializeDateOnly(updated.date_of_birth),
      sex: updated.sex,
    });
  },
);

/**
 * DELETE /children/:childId
 *
 * IMPORTANT: This NEVER touches the underlying patient record, its
 * measurements, or any HCP-managed clinical data. Behavior depends on
 * the source of the child:
 *
 *   - app-source: deletes the parent_child_link (and its
 *     child_hospital_link rows via cascade), and removes the matching
 *     user_patient mirror rows the iOS fan-out put there so the
 *     patient also disappears from myopiamanage.org's regular_user
 *     list. The patient row itself stays.
 *
 *   - web-source: only the user_patient row for this user+patient is
 *     removed (i.e. the same effect as the web "unlink child" button).
 *     The patient row stays.
 */
router.delete("/children/:childId", requireMobileAuth, async (req, res) => {
  const user = requireAppUser(req);
  const child = await findOwnedChild(String(req.params.childId), user.sub);
  if (child == null) {
    res.status(404).json({ error: "child not found", code: "not_found" });
    return;
  }

  if (child.source === "web") {
    await prisma.user_patient.deleteMany({
      where: { user_id: user.sub, patient_id: child.patientId },
    });
    res.json({ ok: true });
    return;
  }

  // app-source: collect linked patient_ids before cascade so we can
  // also clean up the user_patient mirrors.
  const links = await prisma.child_hospital_link.findMany({
    where: { parent_child_link_id: child.childId },
    select: { patient_id: true },
  });
  await prisma.$transaction(async (tx) => {
    await tx.parent_child_link.delete({ where: { id: child.childId } });
    if (links.length > 0) {
      await tx.user_patient.deleteMany({
        where: {
          user_id: user.sub,
          patient_id: { in: links.map((l) => l.patient_id) },
        },
      });
    }
  });
  res.json({ ok: true });
});

/* ------------------------------------------------------------------ *
 * Hospitals + hospital-links                                          *
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 * 부모가 직접 남기는 기록                                              *
 *                                                                    *
 * 병원 측정은 patient 에 매달려 있어 연동 없이는 아무것도 남길 수 없다.
 * 연동은 병원 참여에 달려 있어 사용자가 통제할 수 없으므로, 여기서는
 * 아이(parent_child_link)에 직접 붙인다. 병원 기록과 섞지 않는다 -
 * 출처가 다르면 신뢰도도 다르고, 나중에 연동됐을 때 어느 쪽이 병원
 * 것인지 구분할 수 있어야 한다.
 * ------------------------------------------------------------------ */

/** 안축장은 성인도 24mm 안팎이다. 범위를 벗어난 값은 오타로 본다. */
const axialField = zod.number().min(15).max(35).nullable().optional();
/** 처방 도수. 소아 근시에서 이 범위를 벗어나는 일은 없다. */
const dioptreField = zod.number().min(-30).max(30).nullable().optional();

const childRecordSchema = zod.object({
  recordedOn: zod.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  axialOd: axialField,
  axialOs: axialField,
  sphOd: dioptreField,
  sphOs: dioptreField,
  cylOd: dioptreField,
  cylOs: dioptreField,
  memo: zod.string().max(500).nullable().optional(),
});

const recordDTO = (r: {
  id: string;
  recorded_on: Date;
  axial_od: number | null;
  axial_os: number | null;
  sph_od: number | null;
  sph_os: number | null;
  cyl_od: number | null;
  cyl_os: number | null;
  memo: string | null;
}) => ({
  id: r.id,
  recordedOn: serializeDateOnly(r.recorded_on),
  axialOd: r.axial_od,
  axialOs: r.axial_os,
  sphOd: r.sph_od,
  sphOs: r.sph_os,
  cylOd: r.cyl_od,
  cylOs: r.cyl_os,
  memo: r.memo,
});

/** GET /api/mobile/children/:childId/records */
router.get("/children/:childId/records", requireMobileAuth, async (req, res) => {
  const user = requireAppUser(req);
  const child = await loadOwnedChild(user.sub, String(req.params.childId));
  if (child == null) {
    res.status(404).json({ error: "child not found", code: "not_found" });
    return;
  }
  const rows = await prisma.child_record.findMany({
    where: { parent_child_link_id: child.id },
    orderBy: { recorded_on: "desc" },
    take: 200,
  });
  res.json({ records: rows.map(recordDTO) });
});

/** POST /api/mobile/children/:childId/records */
router.post(
  "/children/:childId/records",
  requireMobileAuth,
  validateRequestBody(childRecordSchema),
  async (req, res) => {
    const user = requireAppUser(req);
    const child = await loadOwnedChild(user.sub, String(req.params.childId));
    if (child == null) {
      res.status(404).json({ error: "child not found", code: "not_found" });
      return;
    }
    const d = req.body as zod.infer<typeof childRecordSchema>;
    // 값이 하나도 없는 기록은 만들지 않는다. 날짜만 남은 줄은 목록에서
    // 무엇을 뜻하는지 알 수 없다.
    const hasValue = [d.axialOd, d.axialOs, d.sphOd, d.sphOs, d.cylOd, d.cylOs].some(
      (v) => v != null,
    );
    if (!hasValue) {
      res
        .status(400)
        .json({ error: "값을 하나 이상 입력해 주세요.", code: "validation_error" });
      return;
    }
    const row = await prisma.child_record.create({
      data: {
        parent_child_link_id: child.id,
        recorded_on: new Date(d.recordedOn),
        axial_od: d.axialOd ?? null,
        axial_os: d.axialOs ?? null,
        sph_od: d.sphOd ?? null,
        sph_os: d.sphOs ?? null,
        cyl_od: d.cylOd ?? null,
        cyl_os: d.cylOs ?? null,
        memo: d.memo ?? null,
      },
    });
    res.status(201).json(recordDTO(row));
  },
);

/** DELETE /api/mobile/children/:childId/records/:recordId */
router.delete(
  "/children/:childId/records/:recordId",
  requireMobileAuth,
  async (req, res) => {
    const user = requireAppUser(req);
    const child = await loadOwnedChild(user.sub, String(req.params.childId));
    if (child == null) {
      res.status(404).json({ error: "child not found", code: "not_found" });
      return;
    }
    // 아이까지 조건에 넣는다. id 만으로 지우면 남의 기록을 지울 수 있다.
    const { count } = await prisma.child_record.deleteMany({
      where: { id: String(req.params.recordId), parent_child_link_id: child.id },
    });
    if (count === 0) {
      res.status(404).json({ error: "record not found", code: "not_found" });
      return;
    }
    res.json({ ok: true });
  },
);

/**
 * GET /api/mobile/children/:childId/progress
 *
 * 안축장이 또래 기준을 넘었는지 한 문장으로 답한다.
 *
 * 차트는 이미 있지만 부모가 그래프를 읽고 판단하기는 어렵다. 근시 관리에서
 * 부모가 알고 싶은 것은 곡선의 모양이 아니라 "지금 괜찮은가" 하나다.
 *
 * 병원 측정과 직접 적은 기록을 함께 본다. 연동이 없는 사람도 답을 받을 수
 * 있어야 하고, 값의 출처가 달라도 눈의 길이는 같은 눈의 길이다.
 */
router.get("/children/:childId/progress", requireMobileAuth, async (req, res) => {
  const user = requireAppUser(req);
  const child = await loadOwnedChild(user.sub, String(req.params.childId));
  if (child == null) {
    res.status(404).json({ error: "child not found", code: "not_found" });
    return;
  }

  const patientIds = (await linkedPatientIds(child.id)).map((p) => p.patientId);
  const [hospital, own] = await Promise.all([
    patientIds.length > 0
      ? prisma.measurement.findMany({
          where: { patient_id: { in: patientIds } },
          orderBy: { date: "desc" },
          take: 20,
        })
      : Promise.resolve([]),
    prisma.child_record.findMany({
      where: { parent_child_link_id: child.id },
      orderBy: { recorded_on: "desc" },
      take: 20,
    }),
  ]);

  // 두 출처를 한 줄로 세운다. 같은 날 둘 다 있으면 병원 값을 쓴다 -
  // 옮겨 적는 과정이 없어 오타가 끼어들 자리가 없다.
  type Point = { date: Date; od: number | null; os: number | null; fromHospital: boolean };
  const points: Point[] = [
    ...hospital.map((m) => ({
      date: m.date,
      od: m.od,
      os: m.os,
      fromHospital: true,
    })),
    ...own.map((r) => ({
      date: r.recorded_on,
      od: r.axial_od,
      os: r.axial_os,
      fromHospital: false,
    })),
  ]
    .filter((p) => p.od != null || p.os != null)
    .sort((a, b) => b.date.getTime() - a.date.getTime());

  if (points.length === 0) {
    res.json({ status: "no_data", latest: null, perYear: null, threshold: null });
    return;
  }

  const latest = points[0];
  const worse = (p: Point) => Math.max(p.od ?? 0, p.os ?? 0);

  // 또래 기준: 만 나이와 성별로 찾는다.
  const age = Math.floor(
    (latest.date.getTime() - child.date_of_birth.getTime()) / (365.25 * 24 * 3600 * 1000),
  );
  const threshold = await prisma.axial_length_threshold.findUnique({
    where: { age_sex: { age, sex: child.sex } },
  });

  // 진행 속도는 1년 안팎으로 떨어진 두 점이 있어야 뜻이 있다. 한 달 간격
  // 두 점으로 연 환산하면 작은 오차가 열두 배로 부풀어 겁을 준다.
  const MIN_GAP_DAYS = 120;
  const earlier = points.find(
    (p) =>
      (latest.date.getTime() - p.date.getTime()) / 86400000 >= MIN_GAP_DAYS &&
      worse(p) > 0,
  );
  let perYear: number | null = null;
  if (earlier != null) {
    const years = (latest.date.getTime() - earlier.date.getTime()) / (365.25 * 86400000);
    // 눈마다 따로 재고 더 많이 자란 쪽을 쓴다. 좌우 최댓값끼리 빼면, 방문마다
    // 긴 눈이 바뀌었을 때 서로 다른 눈을 비교하게 된다.
    const deltas = (["od", "os"] as const)
      .map((eye) =>
        latest[eye] != null && earlier[eye] != null
          ? (latest[eye] as number) - (earlier[eye] as number)
          : null,
      )
      .filter((v): v is number => v != null);
    if (deltas.length > 0) {
      perYear = Number((Math.max(...deltas) / years).toFixed(2));
    }
  }

  // 기준 자료가 없으면 모른다고 답한다. ok 로 뭉뚱그리면 화면에는
  // "또래 기준 안에 있습니다" 가 뜨는데, 실제로는 비교조차 못 한 상태다.
  // 근시 관리 앱에서 거짓 안심은 진료를 미루게 만든다.
  const status =
    threshold == null
      ? "unknown"
      : worse(latest) > threshold.warn_max
        ? "over"
        : "ok";
  res.json({
    status,
    latest: {
      date: serializeDateOnly(latest.date),
      od: latest.od,
      os: latest.os,
      fromHospital: latest.fromHospital,
    },
    /// 연 환산 증가량(mm). 두 점이 충분히 떨어져 있을 때만 낸다.
    perYear,
    threshold: threshold?.warn_max ?? null,
  });
});

/* ---- 매일 하는 치료 체크 --------------------------------------- */

// "outdoor" 는 몇 시간인지가 아니라 오늘 밖에 나갔는지다. 시간은
// child_activity_log 에 따로 남는다 — 체크에서 시간을 지어내면 의사
// 화면에 부모가 말한 적 없는 숫자가 뜬다.
const CARE_KINDS = ["atropine", "lens", "outdoor"] as const;
const careSchema = zod.object({
  kind: zod.enum(CARE_KINDS),
  doneOn: zod.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  done: zod.boolean(),
});

/**
 * GET /api/mobile/children/:childId/care?days=30
 *
 * 최근 며칠치를 한 번에 준다. 날짜마다 물어보면 달력 한 장에 서른 번을
 * 부르게 된다.
 */
router.get("/children/:childId/care", requireMobileAuth, async (req, res) => {
  const user = requireAppUser(req);
  const child = await loadOwnedChild(user.sub, String(req.params.childId));
  if (child == null) {
    res.status(404).json({ error: "child not found", code: "not_found" });
    return;
  }
  const days = Math.min(Math.max(Number(req.query.days ?? 30) || 30, 1), 180);
  const from = new Date();
  from.setUTCHours(0, 0, 0, 0);
  from.setUTCDate(from.getUTCDate() - days + 1);

  const rows = await prisma.child_care_log.findMany({
    where: { parent_child_link_id: child.id, done_on: { gte: from } },
    orderBy: { done_on: "desc" },
  });
  res.json({
    logs: rows.map((r) => ({ kind: r.kind, doneOn: serializeDateOnly(r.done_on) })),
  });
});

/**
 * PUT /api/mobile/children/:childId/care
 *
 * 켜고 끄는 동작이라 POST/DELETE 로 나누지 않는다. 체크박스 하나에
 * 엔드포인트가 둘이면 화면이 상태를 두 번 관리하게 된다.
 */
router.put(
  "/children/:childId/care",
  requireMobileAuth,
  validateRequestBody(careSchema),
  async (req, res) => {
    const user = requireAppUser(req);
    const child = await loadOwnedChild(user.sub, String(req.params.childId));
    if (child == null) {
      res.status(404).json({ error: "child not found", code: "not_found" });
      return;
    }
    const d = req.body as zod.infer<typeof careSchema>;
    const doneOn = new Date(d.doneOn);
    // 오지 않은 날은 체크할 수 없다. 달력을 넘기다 미래를 누르면 기록이
    // 실제와 어긋난다.
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    if (doneOn.getTime() > today.getTime()) {
      res
        .status(400)
        .json({ error: "아직 오지 않은 날짜입니다.", code: "validation_error" });
      return;
    }

    if (d.done) {
      await prisma.child_care_log.upsert({
        where: {
          parent_child_link_id_kind_done_on: {
            parent_child_link_id: child.id,
            kind: d.kind,
            done_on: doneOn,
          },
        },
        create: { parent_child_link_id: child.id, kind: d.kind, done_on: doneOn },
        update: {},
      });
    } else {
      await prisma.child_care_log.deleteMany({
        where: { parent_child_link_id: child.id, kind: d.kind, done_on: doneOn },
      });
    }
    res.json({ ok: true });
  },
);

/* ---- 잊으면 안 되는 날 ------------------------------------------- */

const REMINDER_KINDS = ["appointment", "lens_replace"] as const;
const reminderSchema = zod.object({
  kind: zod.enum(REMINDER_KINDS),
  dueOn: zod.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  memo: zod.string().max(200).nullable().optional(),
});

const reminderDTO = (r: {
  id: string;
  kind: string;
  due_on: Date;
  memo: string | null;
  done_at: Date | null;
}) => ({
  id: r.id,
  kind: r.kind,
  dueOn: serializeDateOnly(r.due_on),
  memo: r.memo,
  done: r.done_at != null,
});

/** GET /api/mobile/children/:childId/reminders */
router.get("/children/:childId/reminders", requireMobileAuth, async (req, res) => {
  const user = requireAppUser(req);
  const child = await loadOwnedChild(user.sub, String(req.params.childId));
  if (child == null) {
    res.status(404).json({ error: "child not found", code: "not_found" });
    return;
  }
  const rows = await prisma.child_reminder.findMany({
    where: { parent_child_link_id: child.id },
    orderBy: { due_on: "asc" },
    take: 100,
  });
  res.json({ reminders: rows.map(reminderDTO) });
});

/** POST /api/mobile/children/:childId/reminders */
router.post(
  "/children/:childId/reminders",
  requireMobileAuth,
  validateRequestBody(reminderSchema),
  async (req, res) => {
    const user = requireAppUser(req);
    const child = await loadOwnedChild(user.sub, String(req.params.childId));
    if (child == null) {
      res.status(404).json({ error: "child not found", code: "not_found" });
      return;
    }
    const d = req.body as zod.infer<typeof reminderSchema>;
    const row = await prisma.child_reminder.create({
      data: {
        parent_child_link_id: child.id,
        kind: d.kind,
        due_on: new Date(d.dueOn),
        memo: d.memo ?? null,
      },
    });
    res.status(201).json(reminderDTO(row));
  },
);

/**
 * PATCH /api/mobile/children/:childId/reminders/:id — 완료 표시
 *
 * 지난 일정을 지우지 않고 완료로 남긴다. 언제 갔었는지가 그 자체로 기록이다.
 */
router.patch(
  "/children/:childId/reminders/:id",
  requireMobileAuth,
  validateRequestBody(zod.object({ done: zod.boolean() })),
  async (req, res) => {
    const user = requireAppUser(req);
    const child = await loadOwnedChild(user.sub, String(req.params.childId));
    if (child == null) {
      res.status(404).json({ error: "child not found", code: "not_found" });
      return;
    }
    const { count } = await prisma.child_reminder.updateMany({
      where: { id: String(req.params.id), parent_child_link_id: child.id },
      data: { done_at: (req.body as { done: boolean }).done ? new Date() : null },
    });
    if (count === 0) {
      res.status(404).json({ error: "reminder not found", code: "not_found" });
      return;
    }
    res.json({ ok: true });
  },
);

/** DELETE /api/mobile/children/:childId/reminders/:id */
router.delete(
  "/children/:childId/reminders/:id",
  requireMobileAuth,
  async (req, res) => {
    const user = requireAppUser(req);
    const child = await loadOwnedChild(user.sub, String(req.params.childId));
    if (child == null) {
      res.status(404).json({ error: "child not found", code: "not_found" });
      return;
    }
    const { count } = await prisma.child_reminder.deleteMany({
      where: { id: String(req.params.id), parent_child_link_id: child.id },
    });
    if (count === 0) {
      res.status(404).json({ error: "reminder not found", code: "not_found" });
      return;
    }
    res.json({ ok: true });
  },
);

router.get("/hospitals", async (_req, res) => {
  const hospitals = await prisma.hospital.findMany({
    include: { country: { select: { code: true } } },
    orderBy: { name: "asc" },
  });
  res.json(
    hospitals.map((h) => ({
      hospitalId: h.id,
      name: h.name,
      code: h.code,
      country: h.country.code,
    })),
  );
});

/* ------------------------------------------------------------------ *
 * Facility finder (기관 찾기)                                          *
 *                                                                    *
 * GET /api/mobile/hospitals/search — public. Returns a unified       *
 * `places` list the iOS "find a facility" map/list screen renders.   *
 *                                                                    *
 *   - type=clinic  → backed by the real partner `hospital` table     *
 *                    (isPartner=true). The current schema only has    *
 *                    name/code, so address/lat/lng/phone/rating are   *
 *                    null until those columns exist.                  *
 *   - type=optical → optical shops (안경원). No data source yet.       *
 *   - type=lasik   → refractive-surgery clinics. No data source yet.  *
 *                                                                    *
 * TODO: optical/lasik data sources are pending — a future additive    *
 * table (or an external Places API proxy) will populate them. For now *
 * they intentionally return an empty `places` array with the same     *
 * response shape so the client contract is stable.                    *
 * ------------------------------------------------------------------ */

type PlaceType = "clinic" | "optical" | "lasik";

type PlaceDTO = {
  id: string;
  name: string;
  type: PlaceType;
  address: string | null;
  lat: number | null;
  lng: number | null;
  distanceKm: number | null;
  phone: string | null;
  rating: number | null;
  isPartner: boolean;
};

/** Haversine great-circle distance in kilometres. */
function haversineKm(
  aLat: number,
  aLng: number,
  bLat: number,
  bLng: number,
): number {
  const R = 6371; // km
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const lat1 = toRad(aLat);
  const lat2 = toRad(bLat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function parseOptionalFloat(v: unknown): number | null {
  if (typeof v !== "string" || v.trim() === "") return null;
  const n = Number.parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

router.get("/hospitals/search", async (req, res) => {
  const typeParam = String(req.query.type ?? "clinic");
  const type: PlaceType =
    typeParam === "optical" || typeParam === "lasik" ? typeParam : "clinic";
  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
  const lat = parseOptionalFloat(req.query.lat);
  const lng = parseOptionalFloat(req.query.lng);
  const limit = Math.min(
    Math.max(
      Number.parseInt(String(req.query.limit ?? "20"), 10) || 20,
      1,
    ),
    50,
  );

  // optical / lasik have no data source yet — keep the contract stable.
  if (type !== "clinic") {
    res.json({ places: [] as PlaceDTO[] });
    return;
  }

  const hospitals = await prisma.hospital.findMany({
    where: q
      ? { name: { contains: q, mode: "insensitive" } }
      : undefined,
    orderBy: { name: "asc" },
  });

  // Map real location/contact columns (nullable). `distanceKm` is computed
  // only when both the caller and the hospital have coordinates; hospitals
  // still lacking lat/lng return null distance and fall back to name order.
  let places: PlaceDTO[] = hospitals.map((h) => {
    const hLat: number | null = h.latitude ?? null;
    const hLng: number | null = h.longitude ?? null;
    const distanceKm =
      lat != null && lng != null && hLat != null && hLng != null
        ? haversineKm(lat, lng, hLat, hLng)
        : null;
    return {
      id: h.id,
      name: h.name,
      type: "clinic" as const,
      address: h.address ?? null,
      lat: hLat,
      lng: hLng,
      distanceKm,
      phone: h.phone ?? null,
      rating: null,
      isPartner: true,
    };
  });

  // Sort by distance ascending when we actually computed it; otherwise
  // leave the name-ordered list from the query intact.
  if (places.some((p) => p.distanceKm != null)) {
    places = places.sort(
      (a, b) => (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity),
    );
  }

  res.json({ places: places.slice(0, limit) });
});

const hospitalLinkSchema = zod.object({
  hospitalCode: zod.string().nonempty(),
  registrationNumber: zod.string().nonempty(),
  // Legal-guardian (법정대리인) consent to collect/use the child's sensitive
  // data (민감정보: 등록번호·생년월일·안축장 등), captured at the moment the
  // hospital record becomes visible to the parent.
  // NOTE: kept optional for now so existing iOS clients aren't broken. Once the
  // iOS app ships the consent checkbox and always sends `guardianConsent: true`,
  // change this to `zod.literal(true)` to make consent mandatory at the API.
  guardianConsent: zod.boolean().optional(),
});

router.post(
  "/children/:childId/hospital-links",
  requireMobileAuth,
  validateRequestBody(hospitalLinkSchema),
  async (req, res) => {
    const user = requireAppUser(req);
    const child = await loadOwnedChild(user.sub, String(req.params.childId));
    if (child == null) {
      res.status(404).json({ error: "child not found", code: "not_found" });
      return;
    }
    const body = req.body as zod.infer<typeof hospitalLinkSchema>;
    const hospital = await prisma.hospital.findUnique({
      where: { code: body.hospitalCode },
    });
    if (hospital == null) {
      res.status(404).json({ error: "no matching record", code: "not_found" });
      return;
    }

    // Find patient by (hospital_id, registration_number_hash).
    const regHash = hashRegistrationNumber(body.registrationNumber.trim());
    const patient = await prisma.patient.findUnique({
      where: {
        registration_number_hash_hospital_id: {
          registration_number_hash: regHash,
          hospital_id: hospital.id,
        },
      },
    });
    if (patient == null) {
      res.status(404).json({ error: "no matching record", code: "not_found" });
      return;
    }

    // Verify DOB + sex match what the parent entered for the child.
    const patientDOB = await decryptSymmetric(patient.encrypted_date_of_birth);
    const childDOB = serializeDateOnly(child.date_of_birth);
    if (patientDOB !== childDOB || patient.sex !== child.sex) {
      res.status(404).json({ error: "no matching record", code: "not_found" });
      return;
    }

    try {
      const link = await prisma.$transaction(async (tx) => {
        // 1) child_hospital_link — iOS-side mapping
        const created = await tx.child_hospital_link.create({
          data: {
            parent_child_link_id: child.id,
            hospital_id: hospital.id,
            patient_id: patient.id,
            status: "active",
          },
        });
        // 2) user_patient — mirror to the web-side mapping so the same
        //    patient also shows up on myopiamanage.org for this user.
        //    upsert handles the case where the user already has the
        //    patient registered on web (just leave the existing row).
        await tx.user_patient.upsert({
          where: {
            user_id_patient_id: {
              user_id: user.sub,
              patient_id: patient.id,
            },
          },
          create: { user_id: user.sub, patient_id: patient.id },
          update: {},
        });
        // 3) patient_consent — record the parent's legal-guardian consent to
        //    process the child's sensitive data. Recorded only when the client
        //    sends guardianConsent (see schema note about making it mandatory).
        if (body.guardianConsent) {
          await tx.patient_consent.create({
            data: {
              patient_id: patient.id,
              given_by: user.sub,
              role: "legal_guardian",
              version: CONSENT_VERSION,
            },
          });
        }
        // 4) 연동 전에 부모가 적어 둔 것을 이 병원 쪽으로 옮긴다.
        //
        //    연동 없이도 기록할 수 있게 되면서, 가입해서 몇 달 적다가
        //    나중에 병원을 연동하는 길이 생겼다. 그때 옮겨 주지 않으면
        //    의사는 연동 이후 것만 보게 된다 — 하필 "그동안 어떻게
        //    지냈나"를 묻는 자리에서 앞부분이 비어 있다.
        //
        //    부모가 옮겨 적은 검사값(child_record)은 보내지 않는다. 활동과
        //    부모 근시는 원래 부모가 답하는 정보지만, 안축장·도수는 병원이
        //    재는 값이다. 그게 차트에서 실제 측정값과 섞이면 어느 것이
        //    측정이고 어느 것이 기억인지 구분할 수 없고, 그 숫자로 근시
        //    진행을 판단한다.
        await backfillToPatient(tx, child.id, patient.id);

        return created;
      });
      res.status(201).json({
        hospitalId: hospital.id,
        hospitalName: hospital.name,
        hospitalCode: hospital.code,
        registrationNumber: body.registrationNumber,
        linkedAt: link.linked_at.toISOString(),
        patientId: patient.id,
      });
    } catch (e) {
      if (e instanceof PrismaClientKnownRequestError && e.code === "P2002") {
        res.status(409).json({
          error: "child is already linked to this hospital",
          code: "validation_error",
        });
        return;
      }
      throw e;
    }
  },
);

/** 표를 집는 데 실패했을 때. 트랜잭션을 되돌리려고 던진다. */
class InviteAlreadyUsed extends Error {}

/* ---- 연동 초대 --------------------------------------------------- *
 *                                                                    *
 * 병원이 만든 일회용 링크로 잇는다. 등록번호를 묻지 않으므로 대입할     *
 * 것이 없다. 토큰 자체가 병원이 이 부모에게 건넨 표다.                 *
 * ------------------------------------------------------------------ */

/** GET /api/mobile/link-invites/:token — 수락 전에 무엇을 잇는지 보여준다. */
router.get("/link-invites/:token", requireMobileAuth, async (req, res) => {
  const r = await resolveInvite(String(req.params.token));
  if ("problem" in r) {
    return res.status(410).json({ error: "invite unusable", code: r.problem });
  }
  // 아이를 특정할 만큼만 보여준다. 부모는 이미 아는 정보이고, 링크를
  // 주운 사람에게는 이것만으로 누구인지 알 수 없어야 한다.
  const dob = await decryptSymmetric(r.invite.patient.encrypted_date_of_birth);
  res.json({
    hospitalName: r.invite.hospital.name,
    dateOfBirth: dob,
    sex: r.invite.patient.sex,
    expiresAt: r.invite.expires_at.toISOString(),
  });
});

const acceptInviteSchema = zod.object({
  token: zod.string().min(10).max(200),
  guardianConsent: zod.boolean().optional(),
});

/** POST /api/mobile/children/:childId/hospital-links/by-invite */
router.post(
  "/children/:childId/hospital-links/by-invite",
  requireMobileAuth,
  validateRequestBody(acceptInviteSchema),
  async (req, res) => {
    const user = requireAppUser(req);
    const child = await loadOwnedChild(user.sub, String(req.params.childId));
    if (child == null) {
      res.status(404).json({ error: "child not found", code: "not_found" });
      return;
    }

    const body = req.body as zod.infer<typeof acceptInviteSchema>;
    const r = await resolveInvite(body.token);
    if ("problem" in r) {
      return res.status(410).json({ error: "invite unusable", code: r.problem });
    }
    const invite = r.invite;

    // 초대가 곧 병원의 확인이지만, 엉뚱한 아이에 붙이는 실수는 막는다.
    // 부모가 아이를 여럿 등록해 두고 잘못 고를 수 있다.
    const patientDOB = await decryptSymmetric(
      invite.patient.encrypted_date_of_birth,
    );
    if (
      patientDOB !== serializeDateOnly(child.date_of_birth) ||
      invite.patient.sex !== child.sex
    ) {
      return res.status(409).json({
        error: "child does not match the invited record",
        code: "mismatch",
      });
    }

    try {
      await prisma.$transaction(async (tx) => {
        // 먼저 표를 쓴다. 조건을 걸어 두면 두 번 눌러도 한 번만 통과한다.
        const claimed = await tx.child_link_invite.updateMany({
          where: { id: invite.id, used_at: null, revoked_at: null },
          data: { used_at: new Date(), used_by: user.sub },
        });
        if (claimed.count === 0) {
          throw new InviteAlreadyUsed();
        }

        await tx.child_hospital_link.create({
          data: {
            parent_child_link_id: child.id,
            hospital_id: invite.hospital_id,
            patient_id: invite.patient_id,
            status: "active",
          },
        });
        await tx.user_patient.upsert({
          where: {
            user_id_patient_id: {
              user_id: user.sub,
              patient_id: invite.patient_id,
            },
          },
          create: { user_id: user.sub, patient_id: invite.patient_id },
          update: {},
        });
        if (body.guardianConsent) {
          await tx.patient_consent.create({
            data: {
              patient_id: invite.patient_id,
              given_by: user.sub,
              role: "legal_guardian",
              version: CONSENT_VERSION,
            },
          });
        }
        await backfillToPatient(tx, child.id, invite.patient_id);
      });
    } catch (e) {
      if (e instanceof InviteAlreadyUsed) {
        return res.status(410).json({ error: "invite unusable", code: "used" });
      }
      if (e instanceof PrismaClientKnownRequestError && e.code === "P2002") {
        return res.status(409).json({
          error: "child is already linked to this hospital",
          code: "validation_error",
        });
      }
      throw e;
    }

    res.status(201).json({
      hospitalId: invite.hospital.id,
      hospitalName: invite.hospital.name,
      hospitalCode: invite.hospital.code,
      patientId: invite.patient_id,
    });
  },
);

router.delete(
  "/children/:childId/hospital-links/:hospitalId",
  requireMobileAuth,
  async (req, res) => {
    const user = requireAppUser(req);
    const child = await loadOwnedChild(user.sub, String(req.params.childId));
    if (child == null) {
      res.status(404).json({ error: "child not found", code: "not_found" });
      return;
    }
    try {
      await prisma.$transaction(async (tx) => {
        // 1) Find the link first so we know which patient_id it pointed at.
        const existing = await tx.child_hospital_link.findUnique({
          where: {
            parent_child_link_id_hospital_id: {
              parent_child_link_id: child.id,
              hospital_id: String(req.params.hospitalId),
            },
          },
        });
        if (existing == null) {
          throw new PrismaClientKnownRequestError("link not found", {
            code: "P2025",
            clientVersion: "n/a",
          });
        }

        // 2) Delete the iOS-side mapping.
        await tx.child_hospital_link.delete({ where: { id: existing.id } });

        // 3) If the user has no remaining child_hospital_link rows
        //    pointing at this patient, also drop the web-side
        //    user_patient mirror so the patient stops showing up in
        //    myopiamanage.org's regular_user list. This only fires if
        //    the user_patient row was originally created by the iOS
        //    fan-out (or if the user has effectively unlinked via the
        //    iOS UI). Web users who linked the patient on web first
        //    will still have their own user_patient row which we
        //    don't recreate when deleting the child_hospital_link, so
        //    the conservative read here is: cleanup is a no-op when
        //    the user_patient was set up before any iOS link existed.
        const stillLinked = await tx.child_hospital_link.findFirst({
          where: {
            patient_id: existing.patient_id,
            parent_child_link: { user_id: user.sub },
          },
        });
        if (stillLinked == null) {
          await tx.user_patient.deleteMany({
            where: { user_id: user.sub, patient_id: existing.patient_id },
          });
        }
      });
      res.json({ ok: true });
    } catch (e) {
      if (e instanceof PrismaClientKnownRequestError && e.code === "P2025") {
        res.status(404).json({ error: "link not found", code: "not_found" });
        return;
      }
      throw e;
    }
  },
);

/* ------------------------------------------------------------------ *
 * Measurements (read-only aggregations across linked hospitals)       *
 * ------------------------------------------------------------------ */

const dateRangeSchema = zod.object({
  from: zod.string().date().optional(),
  to: zod.string().date().optional(),
});

function parseDateRange(query: unknown) {
  const parsed = dateRangeSchema.safeParse(query);
  if (!parsed.success) return null;
  const { from, to } = parsed.data;
  return {
    from: from ? new Date(from) : undefined,
    to: to ? new Date(to) : undefined,
  };
}

async function guardChild(
  req: express.Request,
  res: express.Response,
): Promise<{
  child: OwnedChild;
  patients: Awaited<ReturnType<typeof linkedPatientIds>>;
} | null> {
  const user = requireAppUser(req);
  const child = await findOwnedChild(String(req.params.childId), user.sub);
  if (child == null) {
    res.status(404).json({ error: "child not found", code: "not_found" });
    return null;
  }
  const patients = await linkedPatientIds(child);
  return { child, patients };
}

router.get(
  "/children/:childId/axial-length",
  requireMobileAuth,
  async (req, res) => {
    const loaded = await guardChild(req, res);
    if (!loaded) return;
    const { patients } = loaded;
    if (patients.length === 0) {
      res.json([]);
      return;
    }
    const range = parseDateRange(req.query);
    if (range == null) {
      res
        .status(400)
        .json({ error: "invalid date range", code: "validation_error" });
      return;
    }

    const rows = await prisma.measurement.findMany({
      where: {
        patient_id: { in: patients.map((p) => p.patientId) },
        date: { gte: range.from, lte: range.to },
      },
      include: { instrument: { select: { name: true, id: true } } },
      orderBy: { date: "asc" },
    });

    const byPatient = new Map(patients.map((p) => [p.patientId, p]));
    res.json(
      rows.map((m) => {
        const meta = byPatient.get(m.patient_id)!;
        return {
          date: serializeDateOnly(m.date),
          od: m.od,
          os: m.os,
          instrumentId: m.instrument.id,
          instrumentName: m.instrument.name,
          hospitalId: meta.hospitalId,
          hospitalName: meta.hospitalName,
        };
      }),
    );
  },
);

router.get(
  "/children/:childId/refractive-error",
  requireMobileAuth,
  async (req, res) => {
    const loaded = await guardChild(req, res);
    if (!loaded) return;
    const { patients } = loaded;
    if (patients.length === 0) {
      res.json([]);
      return;
    }
    const range = parseDateRange(req.query);
    if (range == null) {
      res
        .status(400)
        .json({ error: "invalid date range", code: "validation_error" });
      return;
    }
    const rows = await prisma.refractive_error.findMany({
      where: {
        patient_id: { in: patients.map((p) => p.patientId) },
        date: { gte: range.from, lte: range.to },
      },
      include: { refractive_error_method: { select: { name: true } } },
      orderBy: { date: "asc" },
    });
    const byPatient = new Map(patients.map((p) => [p.patientId, p]));
    res.json(
      rows.map((r) => {
        const meta = byPatient.get(r.patient_id)!;
        return {
          date: serializeDateOnly(r.date),
          od_sph: r.od_sph,
          od_cyl: r.od_cyl,
          os_sph: r.os_sph,
          os_cyl: r.os_cyl,
          method: r.refractive_error_method.name,
          hospitalId: meta.hospitalId,
          hospitalName: meta.hospitalName,
        };
      }),
    );
  },
);

router.get(
  "/children/:childId/mean-k",
  requireMobileAuth,
  async (req, res) => {
    const loaded = await guardChild(req, res);
    if (!loaded) return;
    const { patients } = loaded;
    if (patients.length === 0) {
      res.json([]);
      return;
    }
    const rows = await prisma.patient_k.findMany({
      where: { patient_id: { in: patients.map((p) => p.patientId) } },
    });
    const byPatient = new Map(patients.map((p) => [p.patientId, p]));
    res.json(
      rows.map((k) => {
        const meta = byPatient.get(k.patient_id)!;
        return {
          kType: k.k_type,
          od: k.od,
          os: k.os,
          hospitalId: meta.hospitalId,
          hospitalName: meta.hospitalName,
        };
      }),
    );
  },
);

router.get(
  "/children/:childId/treatments",
  requireMobileAuth,
  async (req, res) => {
    const loaded = await guardChild(req, res);
    if (!loaded) return;
    const { patients } = loaded;
    if (patients.length === 0) {
      res.json([]);
      return;
    }
    const rows = await prisma.patient_treatment.findMany({
      where: { patient_id: { in: patients.map((p) => p.patientId) } },
      include: { treatment: { select: { name: true } } },
      orderBy: { start_date: "asc" },
    });
    const byPatient = new Map(patients.map((p) => [p.patientId, p]));
    res.json(
      rows.map((t) => {
        const meta = byPatient.get(t.patient_id)!;
        return {
          id: t.id,
          treatment: t.treatment.name,
          startDate: serializeDateOnly(t.start_date),
          endDate: t.end_date ? serializeDateOnly(t.end_date) : null,
          hospitalId: meta.hospitalId,
          hospitalName: meta.hospitalName,
        };
      }),
    );
  },
);

router.get(
  "/children/:childId/summary",
  requireMobileAuth,
  async (req, res) => {
    const loaded = await guardChild(req, res);
    if (!loaded) return;
    const { patients } = loaded;
    if (patients.length === 0) {
      res.json({
        latestAxial: null,
        latestRefractive: null,
        riskStatus: null,
        measurementCount: 0,
      });
      return;
    }
    const patientIds = patients.map((p) => p.patientId);
    const [latestAxial, latestRefractive, measurementCount] = await Promise.all([
      prisma.measurement.findFirst({
        where: { patient_id: { in: patientIds } },
        orderBy: { date: "desc" },
      }),
      prisma.refractive_error.findFirst({
        where: { patient_id: { in: patientIds } },
        orderBy: { date: "desc" },
      }),
      prisma.measurement.count({
        where: { patient_id: { in: patientIds } },
      }),
    ]);

    // Simple risk heuristic based on the latest axial length. The web app's
    // real risk model can replace this later without changing the contract.
    let riskStatus: "low" | "monitoring" | "moderate" | "high" | null = null;
    if (latestAxial) {
      const maxEye = Math.max(latestAxial.od ?? 0, latestAxial.os ?? 0);
      if (maxEye >= 26) riskStatus = "high";
      else if (maxEye >= 25) riskStatus = "moderate";
      else if (maxEye >= 24) riskStatus = "monitoring";
      else riskStatus = "low";
    }

    res.json({
      latestAxial: latestAxial
        ? {
            date: serializeDateOnly(latestAxial.date),
            od: latestAxial.od,
            os: latestAxial.os,
          }
        : null,
      latestRefractive: latestRefractive
        ? {
            date: serializeDateOnly(latestRefractive.date),
            od_sph: latestRefractive.od_sph,
            od_cyl: latestRefractive.od_cyl,
            os_sph: latestRefractive.os_sph,
            os_cyl: latestRefractive.os_cyl,
          }
        : null,
      riskStatus,
      measurementCount,
    });
  },
);

/* ------------------------------------------------------------------ *
 * Parent-entered data: parental refraction + lifestyle activity        *
 *                                                                      *
 * 저장은 아이(parent_child_link)에 한다. 예전에는 patient 에만 넣어서    *
 * 병원 연동이 없는 아이는 아무것도 남길 수 없었는데, 연동은 병원 참여에  *
 * 달려 있어 사용자가 통제할 수 없다.                                    *
 *                                                                      *
 * 연동이 있으면 patient 쪽에도 그대로 내보낸다 — 의사 화면이 보는 곳이   *
 * 거기다. 읽을 때는 둘을 합치고 같은 값은 한 번만 센다.                 *
 *                                                                      *
 * NOTE: parental_myopia rows are kept "current value only" — a PUT     *
 * deletes any existing rows for that patient+sex and inserts one new   *
 * row, since parental refraction doesn't change meaningfully over      *
 * time. Lifestyle activity rows are append-only timeline entries so    *
 * the web charts can show trend.                                       *
 * ------------------------------------------------------------------ */

const PARENT_SEX_VALUES = ["male", "female"] as const;
const MYOPIA_STATUS_VALUES = [
  "myopia",
  "high_myopia",
  "emmetropia",
  "hyperopia",
  "unknown",
] as const;

/** GET /api/mobile/children/:childId/parental-myopia
 * Returns the latest parental_myopia_status row for each parent_sex
 * across the linked patients. If multiple linked patients have rows we
 * trust them to be in sync (we always write through both); we report
 * the most recent timestamp.
 */
router.get(
  "/children/:childId/parental-myopia",
  requireMobileAuth,
  async (req, res) => {
    const userId = req.mobileUser!.sub;
    const child = await findOwnedChild(String(req.params.childId), userId);
    if (child == null) return res.status(404).json({ error: "child not found" });

    // 아이에 붙은 값이 먼저다. 없으면 이 기능이 생기기 전에 patient 로만
    // 들어간 값이 있을 수 있어 그쪽을 본다.
    const own =
      child.source === "app"
        ? await prisma.child_parental_myopia.findMany({
            where: { parent_child_link_id: child.childId },
          })
        : [];

    const links = await linkedPatientIds(child);
    const legacy =
      links.length > 0
        ? await prisma.patient_parental_myopia_status.findMany({
            where: { patient_id: { in: links.map((l) => l.patientId) } },
            orderBy: { timestamp: "desc" },
          })
        : [];

    // 한쪽 부모씩 따로 본다. 어머니만 새로 넣었다고 해서 예전에 patient 로만
    // 들어간 아버지 값이 화면에서 사라지면 안 된다.
    function pick(sex: SexEnum) {
      const mine = own.find((r) => r.parent_sex === sex);
      if (mine != null) {
        return {
          status: mine.status,
          sphOd: mine.sph_od,
          sphOs: mine.sph_os,
          recordedAt: mine.recorded_at.toISOString(),
        };
      }
      const old = legacy.find((r) => r.parent_sex === sex);
      return old
        ? {
            status: old.status,
            sphOd: null,
            sphOs: null,
            recordedAt: old.timestamp.toISOString(),
          }
        : null;
    }

    res.json({ mother: pick(SexEnum.female), father: pick(SexEnum.male) });
  },
);

/** PUT /api/mobile/children/:childId/parental-myopia
 *
 * Body: { mother?: { status: myopia_status } | null,
 *         father?: { status: myopia_status } | null }
 *
 * For each provided parent the server: (1) deletes existing rows for
 * (patient_id, parent_sex) on every linked patient; (2) inserts one new
 * row per linked patient. Pass `null` to clear ("Don't know" without
 * even storing 'unknown'); omit the key to leave that parent untouched.
 */
// 도수는 아는 부모만 적는다. -20 ~ +20 D 를 벗어난 값은 오타다.
const parentEntrySchema = zod.object({
  status: zod.enum(MYOPIA_STATUS_VALUES),
  sphOd: zod.number().min(-20).max(20).nullish(),
  sphOs: zod.number().min(-20).max(20).nullish(),
});

const parentalMyopiaUpdateSchema = zod.object({
  mother: parentEntrySchema.nullable().optional(),
  father: parentEntrySchema.nullable().optional(),
});

router.put(
  "/children/:childId/parental-myopia",
  requireMobileAuth,
  validateRequestBody(parentalMyopiaUpdateSchema),
  async (req, res) => {
    const userId = req.mobileUser!.sub;
    const child = await findOwnedChild(String(req.params.childId), userId);
    if (child == null) return res.status(404).json({ error: "child not found" });

    const links = await linkedPatientIds(child);
    // 연동이 없어도 저장한다. 아이에 붙는 자리가 따로 있다.
    if (links.length === 0 && child.source !== "app") {
      return res
        .status(400)
        .json({ error: "child has no linked hospitals to write to" });
    }

    const body = req.body as zod.infer<typeof parentalMyopiaUpdateSchema>;

    const tasks: {
      sex: SexEnum;
      status: MyopiaStatusEnum | null;
      sphOd: number | null;
      sphOs: number | null;
    }[] = [];
    for (const [key, sex] of [
      ["mother", SexEnum.female],
      ["father", SexEnum.male],
    ] as const) {
      if (!(key in body)) continue;
      const entry = body[key];
      tasks.push({
        sex,
        status: entry == null ? null : (entry.status as MyopiaStatusEnum),
        sphOd: entry?.sphOd ?? null,
        sphOs: entry?.sphOs ?? null,
      });
    }

    await prisma.$transaction(async (tx) => {
      for (const t of tasks) {
        if (child.source === "app") {
          await tx.child_parental_myopia.deleteMany({
            where: { parent_child_link_id: child.childId, parent_sex: t.sex },
          });
          if (t.status != null) {
            await tx.child_parental_myopia.create({
              data: {
                parent_child_link_id: child.childId,
                parent_sex: t.sex,
                status: t.status,
                sph_od: t.sphOd,
                sph_os: t.sphOs,
              },
            });
          }
        }

        if (links.length === 0) continue;
        // wipe existing rows for every linked patient + this parent_sex
        await tx.patient_parental_myopia_status.deleteMany({
          where: {
            patient_id: { in: links.map((l) => l.patientId) },
            parent_sex: t.sex,
          },
        });
        if (t.status == null) continue;
        // insert a fresh row on every linked patient
        await tx.patient_parental_myopia_status.createMany({
          data: links.map((l) => ({
            patient_id: l.patientId,
            parent_sex: t.sex,
            status: t.status as MyopiaStatusEnum,
          })),
        });
      }
    });

    res.json({ ok: true, hospitalsWritten: links.length });
  },
);

/** Lifestyle activity helpers
 *
 * Both nearwork and outdoor share the exact same shape — a tiny generic
 * keeps things terse while staying typesafe.
 */
type ActivityKind = "nearwork" | "outdoor";

const lifestyleEntrySchema = zod.object({
  // 앱의 "모름". 값을 모른다는 것도 기록이다 — 400 으로 되돌려 보내면
  // 그 선택지가 화면에만 있고 눌리지 않는다.
  hours: zod.number().int().min(0).max(24).nullable(),
  recordedAt: zod.string().datetime().optional(),
});

/** 한 번에 내려보내는 활동 이력 줄 수.
 *
 *  매일 적으면 1년에 365줄이 쌓이는데 화면은 최근 몇 줄만 그린다. 제한이
 *  없으면 쓸수록 응답이 무거워진다. 연동 병원 수만큼 같은 값이 겹쳐 오므로
 *  중복을 걷어낸 뒤에도 화면에 쓸 만큼 남도록 넉넉히 가져온다. */
const ACTIVITY_HISTORY_LIMIT = 60;

async function listActivity(
  kind: ActivityKind,
  patientIds: string[],
): Promise<{ id: string; hours: number | null; recordedAt: string }[]> {
  const where = { patient_id: { in: patientIds } };
  const take = ACTIVITY_HISTORY_LIMIT * Math.max(patientIds.length, 1);
  const rows =
    kind === "nearwork"
      ? await prisma.patient_nearwork_activity.findMany({
          where,
          orderBy: { timestamp: "desc" },
          take,
        })
      : await prisma.patient_outdoor_activity.findMany({
          where,
          orderBy: { timestamp: "desc" },
          take,
        });
  // collapse duplicates from fan-out: same (timestamp, hours) across
  // hospitals counts as a single entry.
  const seen = new Set<string>();
  const out: { id: string; hours: number | null; recordedAt: string }[] = [];
  for (const r of rows) {
    const key = `${r.timestamp.toISOString()}|${r.hours ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      id: r.id,
      hours: r.hours,
      recordedAt: r.timestamp.toISOString(),
    });
  }
  return out;
}

async function createActivity(
  kind: ActivityKind,
  links: { patientId: string }[],
  hours: number | null,
  recordedAt: Date,
) {
  const data = links.map((l) => ({
    patient_id: l.patientId,
    hours,
    timestamp: recordedAt,
  }));
  if (kind === "nearwork") {
    await prisma.patient_nearwork_activity.createMany({ data });
  } else {
    await prisma.patient_outdoor_activity.createMany({ data });
  }
}

function makeActivityRoutes(kind: ActivityKind, urlSegment: string) {
  router.get(
    `/children/:childId/${urlSegment}`,
    requireMobileAuth,
    async (req, res) => {
      const userId = req.mobileUser!.sub;
      const child = await findOwnedChild(String(req.params.childId), userId);
      if (child == null) return res.status(404).json({ error: "child not found" });

      // 아이에 붙은 것 + 연동된 병원 것. 같은 값이 양쪽에 있으므로
      // (시각, 시간) 이 같으면 한 줄로 친다.
      const own =
        child.source === "app"
          ? await prisma.child_activity_log.findMany({
              where: { parent_child_link_id: child.childId, kind },
              orderBy: { recorded_at: "desc" },
              take: ACTIVITY_HISTORY_LIMIT,
            })
          : [];
      const links = await linkedPatientIds(child);
      const fromHospital =
        links.length > 0
          ? await listActivity(kind, links.map((l) => l.patientId))
          : [];

      const seen = new Set<string>();
      const entries: { id: string; hours: number | null; recordedAt: string }[] = [];
      for (const r of [
        ...own.map((r) => ({
          id: r.id,
          hours: r.hours,
          recordedAt: r.recorded_at.toISOString(),
        })),
        ...fromHospital,
      ]) {
        const key = `${r.recordedAt}|${r.hours ?? ""}`;
        if (seen.has(key)) continue;
        seen.add(key);
        entries.push(r);
      }
      entries.sort((a, b) => b.recordedAt.localeCompare(a.recordedAt));
      res.json({ entries: entries.slice(0, ACTIVITY_HISTORY_LIMIT) });
    },
  );

  router.post(
    `/children/:childId/${urlSegment}`,
    requireMobileAuth,
    validateRequestBody(lifestyleEntrySchema),
    async (req, res) => {
      const userId = req.mobileUser!.sub;
      const child = await findOwnedChild(String(req.params.childId), userId);
      if (child == null) return res.status(404).json({ error: "child not found" });

      const links = await linkedPatientIds(child);
      // 연동이 없어도 저장한다. 아이에 붙는 자리가 따로 있다.
      if (links.length === 0 && child.source !== "app") {
        return res
          .status(400)
          .json({ error: "child has no linked hospitals to write to" });
      }

      const body = req.body as zod.infer<typeof lifestyleEntrySchema>;
      const recordedAt = body.recordedAt ? new Date(body.recordedAt) : new Date();
      if (child.source === "app") {
        await prisma.child_activity_log.create({
          data: {
            parent_child_link_id: child.childId,
            kind,
            hours: body.hours,
            recorded_at: recordedAt,
          },
        });
      }
      if (links.length > 0) {
        await createActivity(kind, links, body.hours, recordedAt);
      }

      res.status(201).json({
        ok: true,
        hours: body.hours,
        recordedAt: recordedAt.toISOString(),
        hospitalsWritten: links.length,
      });
    },
  );
}

makeActivityRoutes("nearwork", "nearwork-activity");
makeActivityRoutes("outdoor", "outdoor-activity");

/** GET /api/mobile/children/:childId/lifestyle-reminder
 *
 * Returns a small summary used by the iOS reminder banner: the most
 * recent nearwork + outdoor entry timestamps, and a `dueForUpdate` flag
 * that the app uses to decide whether to nag the parent. The cadence is
 * 6 months — anything older than that triggers the banner.
 */
router.get(
  "/children/:childId/lifestyle-reminder",
  requireMobileAuth,
  async (req, res) => {
    const userId = req.mobileUser!.sub;
    const child = await findOwnedChild(String(req.params.childId), userId);
    if (child == null) return res.status(404).json({ error: "child not found" });

    const links = await linkedPatientIds(child);
    if (links.length === 0) {
      return res.json({
        dueForUpdate: false,
        nearwork: null,
        outdoor: null,
      });
    }
    const patientIds = links.map((l) => l.patientId);
    const [latestNearwork, latestOutdoor] = await Promise.all([
      prisma.patient_nearwork_activity.findFirst({
        where: { patient_id: { in: patientIds } },
        orderBy: { timestamp: "desc" },
      }),
      prisma.patient_outdoor_activity.findFirst({
        where: { patient_id: { in: patientIds } },
        orderBy: { timestamp: "desc" },
      }),
    ]);

    const SIX_MONTHS_MS = 1000 * 60 * 60 * 24 * 30 * 6;
    const now = Date.now();
    const isStale = (d: Date | null | undefined) =>
      d == null || now - d.getTime() > SIX_MONTHS_MS;

    res.json({
      dueForUpdate:
        isStale(latestNearwork?.timestamp) || isStale(latestOutdoor?.timestamp),
      nearwork: latestNearwork
        ? {
            hours: latestNearwork.hours,
            recordedAt: latestNearwork.timestamp.toISOString(),
          }
        : null,
      outdoor: latestOutdoor
        ? {
            hours: latestOutdoor.hours,
            recordedAt: latestOutdoor.timestamp.toISOString(),
          }
        : null,
    });
  },
);

/**
 * 아이에 붙어 있던 부모 입력값을 patient 쪽으로 복사한다.
 *
 * 이미 있는 줄은 건너뛴다 - 같은 병원을 끊었다 다시 이으면 두 번 도는데,
 * 그때마다 같은 값이 쌓이면 의사 화면의 이력이 부풀어 오른다.
 */
async function backfillToPatient(
  tx: Prisma.TransactionClient,
  parentChildLinkId: string,
  patientId: string,
): Promise<void> {
  const acts = await tx.child_activity_log.findMany({
    where: { parent_child_link_id: parentChildLinkId },
  });
  // 두 테이블의 델리게이트는 타입이 달라 변수 하나에 담을 수 없다.
  // 갈래마다 읽고 쓰되, 그 사이 계산은 한곳에 둔다.
  const toInsert = (
    rows: { hours: number | null; recorded_at: Date }[],
    existing: { timestamp: Date; hours: number | null }[],
  ) => {
    const seen = new Set(
      existing.map((e) => `${e.timestamp.toISOString()}|${e.hours ?? ""}`),
    );
    return rows
      .filter((r) => !seen.has(`${r.recorded_at.toISOString()}|${r.hours ?? ""}`))
      .map((r) => ({
        patient_id: patientId,
        hours: r.hours,
        timestamp: r.recorded_at,
      }));
  };

  const near = acts.filter((a) => a.kind === "nearwork");
  if (near.length > 0) {
    const data = toInsert(
      near,
      await tx.patient_nearwork_activity.findMany({
        where: { patient_id: patientId },
        select: { timestamp: true, hours: true },
      }),
    );
    if (data.length > 0) await tx.patient_nearwork_activity.createMany({ data });
  }

  const out = acts.filter((a) => a.kind === "outdoor");
  if (out.length > 0) {
    const data = toInsert(
      out,
      await tx.patient_outdoor_activity.findMany({
        where: { patient_id: patientId },
        select: { timestamp: true, hours: true },
      }),
    );
    if (data.length > 0) await tx.patient_outdoor_activity.createMany({ data });
  }

  // 부모 근시는 빈 자리만 채운다.
  //
  // 병원이 이미 문진으로 받아 둔 값이 있을 수 있는데, 연동했다는 이유만으로
  // 그걸 덮으면 의사가 직접 적은 것이 조용히 사라진다. 부모가 앱에서
  // 고쳐 넣는 것은 지금처럼 PUT 이 덮어쓴다 — 그건 사용자가 그 순간
  // 의도한 행동이다.
  const parental = await tx.child_parental_myopia.findMany({
    where: { parent_child_link_id: parentChildLinkId },
  });
  for (const p of parental) {
    const already = await tx.patient_parental_myopia_status.findFirst({
      where: { patient_id: patientId, parent_sex: p.parent_sex as SexEnum },
    });
    if (already != null) continue;
    await tx.patient_parental_myopia_status.create({
      data: {
        patient_id: patientId,
        parent_sex: p.parent_sex as SexEnum,
        status: p.status as MyopiaStatusEnum,
        // 옮겨 적는 것이지 지금 답한 것이 아니다. 부모가 적은 날을 남긴다.
        timestamp: p.recorded_at,
      },
    });
  }
}

/* ================================================================== *
 * Community board (자유게시판)                                         *
 *                                                                    *
 * Posts and comments are soft-deleted via the deleted_at column —    *
 * we never DELETE rows so reply chains remain navigable. The API     *
 * filters out deleted rows for everyone except the original author,  *
 * who instead sees a tombstoned placeholder body so they know the    *
 * delete actually took effect.                                       *
 *                                                                    *
 * Likes are idempotent on the DB side via composite primary keys —   *
 * POST /like twice is a no-op, DELETE /like is also idempotent.      *
 * ================================================================== */

const POST_LIST_PAGE_SIZE = 20;
const COMMENT_PAGE_SIZE = 200; // realistically a single post won't exceed this

// Guests can read the community (optionalMobileAuth), but likedByMe/isMe are
// per-viewer. Rather than making the `likes` include conditional (messy
// Prisma/TS typing), a guest's viewerId falls back to this sentinel — a
// well-formed UUID that can never match a real user row — so the "did this
// viewer like it" filter always resolves to "no" instead of "any user".
const NO_VIEWER = "00000000-0000-0000-0000-000000000000";

type CommunityAuthorDTO = {
  id: string;
  username: string | null;
  isMe: boolean;
};

async function authorDTO(userId: string, viewerId: string): Promise<CommunityAuthorDTO> {
  const u = await prisma.user.findUnique({
    where: { id: userId },
    include: { password_auth: true },
  });
  return {
    id: userId,
    username: u?.password_auth?.username ?? null,
    isMe: userId === viewerId,
  };
}

/** GET /api/mobile/community/posts?cursor=<id>&pageSize=20
 *
 * Reverse-chronological feed. Pagination uses created_at + id as a
 * keyset cursor so it survives concurrent inserts without dupes/gaps.
 */
router.get("/community/posts", optionalMobileAuth, async (req, res) => {
  const viewerId = req.mobileUser?.sub ?? NO_VIEWER;
  const pageSize = Math.min(
    Number.parseInt(String(req.query.pageSize ?? POST_LIST_PAGE_SIZE), 10) ||
      POST_LIST_PAGE_SIZE,
    50,
  );
  const cursor = typeof req.query.cursor === "string" ? req.query.cursor : null;
  const categoryParam = String(req.query.category ?? "");
  const category: PostCategory | null = POST_CATEGORIES.includes(
    categoryParam as PostCategory,
  )
    ? (categoryParam as PostCategory)
    : null;
  // 치료탭의 치료별 화면이 그 치료의 후기만 받아 가려고 쓴다.
  const treatmentParam = String(req.query.treatment ?? "");
  const treatment = TREATMENT_CATEGORIES.includes(
    treatmentParam as (typeof TREATMENT_CATEGORIES)[number],
  )
    ? treatmentParam
    : null;

  const cursorRow = cursor
    ? await prisma.community_post.findUnique({ where: { id: cursor } })
    : null;

  const notBlocked = await authorBlockFilter(req.mobileUser?.sub);

  const rows = await prisma.community_post.findMany({
    where: {
      deleted_at: null,
      ...notBlocked,
      ...(category != null && { category }),
      ...(treatment != null && { treatment_category: treatment }),
      ...(cursorRow != null && {
        OR: [
          { created_at: { lt: cursorRow.created_at } },
          {
            created_at: cursorRow.created_at,
            id: { lt: cursorRow.id },
          },
        ],
      }),
    },
    orderBy: [{ created_at: "desc" }, { id: "desc" }],
    take: pageSize + 1, // fetch one extra to know if there's more
    include: {
      _count: { select: { comments: true, likes: true } },
      likes: { where: { user_id: viewerId }, take: 1 },
      user: { include: { password_auth: true } },
    },
  });

  const hasMore = rows.length > pageSize;
  const slice = rows.slice(0, pageSize);
  const nextCursor = hasMore ? slice[slice.length - 1].id : null;

  res.json({
    posts: slice.map((p) => ({
      id: p.id,
      title: p.title,
      category: p.category,
      treatmentCategory: p.treatment_category,
      bodyPreview: p.body.length > 200 ? p.body.slice(0, 200) + "…" : p.body,
      author: {
        id: p.user_id,
        username: p.user.password_auth?.username ?? null,
        isMe: p.user_id === viewerId,
      },
      createdAt: p.created_at.toISOString(),
      updatedAt: p.updated_at.toISOString(),
      commentCount: p._count.comments,
      likeCount: p._count.likes,
      likedByMe: p.likes.length > 0,
    })),
    nextCursor,
  });
});

// "general" is 시술/수술 질문; "chat" is 자유수다 (free talk).
const POST_CATEGORIES = ["review", "general", "chat"] as const;
type PostCategory = (typeof POST_CATEGORIES)[number];

/** 치료탭의 다섯 항목. myodoc TreatmentCategoryScreen, myopia
 *  treatmentCategories.ts 와 같은 키를 쓴다. `dreamLens` 는 이미 그 키로
 *  태그된 병원 프로필이 있어 그대로 두었다. */
const TREATMENT_CATEGORIES = [
  "dreamLens",
  "myopiaGlasses",
  "atropine",
  "misight",
  "other",
] as const;

const createPostSchema = zod.object({
  title: zod.string().trim().min(1).max(200),
  body: zod.string().trim().min(1).max(20_000),
  category: zod.enum(POST_CATEGORIES).optional(),
  treatmentCategory: zod.enum(TREATMENT_CATEGORIES).nullish(),
});

/** 치료 태그는 치료후기에만 의미가 있다. 자유수다 글에 드림렌즈 태그가
 *  붙으면 치료 화면의 후기 목록에 잡담이 섞인다. */
function treatmentTagFor(
  category: string,
  tag: string | null | undefined,
): string | null {
  return category === "review" ? (tag ?? null) : null;
}

/** POST /api/mobile/community/posts */
router.post(
  "/community/posts",
  requireMobileAuth,
  validateRequestBody(createPostSchema),
  async (req, res) => {
    const userId = req.mobileUser!.sub;
    const { title, body, category, treatmentCategory } = req.body as zod.infer<
      typeof createPostSchema
    >;
    const resolved = category ?? "general";
    const post = await prisma.community_post.create({
      data: {
        user_id: userId,
        title,
        body,
        category: resolved,
        treatment_category: treatmentTagFor(resolved, treatmentCategory),
      },
    });
    res.status(201).json({
      id: post.id,
      title: post.title,
      body: post.body,
      category: post.category,
      treatmentCategory: post.treatment_category,
      author: await authorDTO(userId, userId),
      createdAt: post.created_at.toISOString(),
      updatedAt: post.updated_at.toISOString(),
      commentCount: 0,
      likeCount: 0,
      likedByMe: false,
    });
  },
);

/**
 * GET /api/mobile/community/posts/popular — the home screen's 인기글.
 *
 * Ranking, not raw counts. Three signals, weighted by how much effort each one
 * takes: a view is a glance, a like/vote is a tap, a comment is someone writing
 * something. Views alone would reward clickbait titles; likes alone put a post
 * with two hearts above one people are actually reading.
 *
 * Posts only. Polls are ranked by /polls/popular and shown as their own section,
 * because a poll and a post aren't the same thing to read — mixed into one list
 * the poll just looks like a post with a strange title.
 *
 * Then it decays with age, so the section answers "what's live today" instead
 * of showing the same all-time winners forever. The candidate window is a week
 * rather than a calendar day on purpose — on a quiet day, "today only" leaves
 * the home screen with an empty section, which looks broken rather than quiet.
 */
/** Display names for a set of user ids in one query. Polls carry no `user`
 *  relation, so their authors have to be resolved separately from posts'. */
async function usernameMapFor(userIds: string[]): Promise<Map<string, string | null>> {
  const unique = [...new Set(userIds)];
  if (unique.length === 0) return new Map();
  const rows = await prisma.password_auth.findMany({
    where: { user_id: { in: unique } },
    select: { user_id: true, username: true },
  });
  return new Map(rows.map((r) => [r.user_id, r.username]));
}


router.get("/community/posts/popular", optionalMobileAuth, async (req, res) => {
  const limit = Math.min(Math.max(Number.parseInt(String(req.query.limit ?? "3"), 10) || 3, 1), 10);
  const since = popularSince();
  const notBlocked = await authorBlockFilter(req.mobileUser?.sub);

  const rows = await prisma.community_post.findMany({
    where: { deleted_at: null, created_at: { gte: since }, ...notBlocked },
    include: {
      _count: { select: { comments: { where: { deleted_at: null } }, likes: true } },
      user: { include: { password_auth: true } },
    },
    // Bounded so the scoring below stays cheap; a week of posts is small today.
    // The ordering matters even so: without it the 200 rows we keep are an
    // arbitrary slice once a week exceeds that, and a genuinely popular post
    // could be dropped before scoring ever sees it. Newest-first also lines up
    // with the decay, which already favours recent posts.
    orderBy: { created_at: "desc" },
    take: 200,
  });

  const viewerId = req.mobileUser?.sub ?? NO_VIEWER;
  const now = Date.now();

  const score = (views: number, taps: number, comments: number, createdAt: Date) =>
    hotScore(views, taps, comments, createdAt, now);

  type Item = { createdAt: Date; score: number; dto: Record<string, unknown> };

  /** 글 한 건을 점수와 DTO로. 창 안/밖 두 곳에서 같은 모양이 필요하다. */
  const toItem = (p: (typeof rows)[number]): Item => ({
    createdAt: p.created_at,
    score: score(p.view_count, p._count.likes, p._count.comments, p.created_at),
    dto: {
      id: p.id,
      title: p.title,
      category: p.category,
      treatmentCategory: p.treatment_category,
      bodyPreview: p.body.replace(/\s+/g, " ").trim().slice(0, 120),
      author: {
        id: p.user_id,
        username: p.user.password_auth?.username ?? null,
        isMe: p.user_id === viewerId,
      },
      createdAt: p.created_at.toISOString(),
      viewCount: p.view_count,
      likeCount: p._count.likes,
      commentCount: p._count.comments,
    },
  });

  const postItems: Item[] = rows.map(toItem);

  const all = postItems;
  const ranked = all
    // Something nobody has touched isn't "popular", however new it is.
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  // Top up with the newest items when too few have any engagement yet.
  // A young board has almost nothing liked or commented on, and a home section
  // headed "인기글" showing a single row reads as broken rather than quiet.
  // Ranked items keep their order and always come first; the filler is only
  // ever what's left over.
  const chosen = [...ranked];
  const topUp = (items: Item[]) => {
    const taken = new Set(chosen.map((x) => x.dto.id));
    for (const x of [...items].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())) {
      if (chosen.length >= limit) break;
      if (!taken.has(x.dto.id)) chosen.push(x);
    }
  };
  topUp(all);

  // 창(7일) 안이 통째로 비면 위 채우기도 채울 것이 없어 섹션이 사라진다.
  // 홈에서 커뮤니티가 아예 안 보이면 사용자는 그런 기능이 있는 줄도 모르게
  // 되는데, 이건 조용한 것보다 나쁘다. 그래서 창 밖에서라도 최신 글을 가져온다.
  //
  // 창을 늘리지 않는 이유: 7일은 "지금 살아있는 글"이라는 랭킹의 뜻을 지탱하는
  // 값이다. 늘리면 3주 전 글이 계속 '인기글'로 앉아 있게 된다. 대신 창 밖에서
  // 채웠다는 사실을 클라이언트에 알려, 제목을 '인기글'이 아니라 '새 글'로
  // 바꿔 달게 한다 - 오래된 글을 인기글이라 부르지 않는 것이 핵심이다.
  if (chosen.length < limit) {
    const older = await prisma.community_post.findMany({
      where: { deleted_at: null, created_at: { lt: since }, ...notBlocked },
      include: {
        _count: { select: { comments: { where: { deleted_at: null } }, likes: true } },
        user: { include: { password_auth: true } },
      },
      orderBy: { created_at: "desc" },
      take: limit,
    });
    topUp(older.map(toItem));
  }

  res.json({
    posts: chosen.map((x) => x.dto),
    // 랭킹에 오른 글이 하나도 없으면 이 목록은 '인기글'이 아니라 '새 글'이다.
    fallback: ranked.length === 0,
  });
});

/** GET /api/mobile/community/posts/:id */
router.get("/community/posts/:id", optionalMobileAuth, async (req, res) => {
  const viewerId = req.mobileUser?.sub ?? NO_VIEWER;
  const post = await prisma.community_post.findUnique({
    where: { id: String(req.params.id) },
    include: {
      _count: { select: { comments: { where: { deleted_at: null } }, likes: true } },
      likes: { where: { user_id: viewerId }, take: 1 },
      user: { include: { password_auth: true } },
    },
  });
  if (post == null || post.deleted_at != null) {
    return res.status(404).json({ error: "post not found" });
  }

  // Count the read, but not the author re-reading their own post — otherwise
  // "인기글" rewards whoever refreshes their own thread the most. Fire and
  // forget: a failed counter must never fail the read.
  if (post.user_id !== viewerId) {
    prisma.community_post
      .update({ where: { id: post.id }, data: { view_count: { increment: 1 } } })
      .catch((err) => console.error("[views] increment failed", err));
  }

  res.json({
    id: post.id,
    title: post.title,
    body: post.body,
    category: post.category,
    treatmentCategory: post.treatment_category,
    viewCount: post.view_count,
    author: {
      id: post.user_id,
      username: post.user.password_auth?.username ?? null,
      isMe: post.user_id === viewerId,
    },
    createdAt: post.created_at.toISOString(),
    updatedAt: post.updated_at.toISOString(),
    commentCount: post._count.comments,
    likeCount: post._count.likes,
    likedByMe: post.likes.length > 0,
  });
});

const updatePostSchema = zod.object({
  title: zod.string().trim().min(1).max(200).optional(),
  body: zod.string().trim().min(1).max(20_000).optional(),
  treatmentCategory: zod.enum(TREATMENT_CATEGORIES).nullish(),
});

/** PATCH /api/mobile/community/posts/:id — author only */
router.patch(
  "/community/posts/:id",
  requireMobileAuth,
  validateRequestBody(updatePostSchema),
  async (req, res) => {
    const userId = req.mobileUser!.sub;
    const post = await prisma.community_post.findUnique({
      where: { id: String(req.params.id) },
    });
    if (post == null || post.deleted_at != null) {
      return res.status(404).json({ error: "post not found" });
    }
    if (post.user_id !== userId) {
      return res.status(403).json({ error: "not your post" });
    }
    const { treatmentCategory, ...data } = req.body as zod.infer<
      typeof updatePostSchema
    >;
    if (
      data.title == null &&
      data.body == null &&
      treatmentCategory === undefined
    ) {
      return res.status(400).json({ error: "nothing to update" });
    }
    const updated = await prisma.community_post.update({
      where: { id: post.id },
      data: {
        ...data,
        // 게시판은 수정으로 바뀌지 않으므로 저장된 category 로 판단한다.
        ...(treatmentCategory !== undefined && {
          treatment_category: treatmentTagFor(post.category, treatmentCategory),
        }),
      },
    });
    res.json({
      id: updated.id,
      title: updated.title,
      body: updated.body,
      treatmentCategory: updated.treatment_category,
      updatedAt: updated.updated_at.toISOString(),
    });
  },
);

/** DELETE /api/mobile/community/posts/:id — soft-delete; author only */
router.delete("/community/posts/:id", requireMobileAuth, async (req, res) => {
  const userId = req.mobileUser!.sub;
  const post = await prisma.community_post.findUnique({
    where: { id: String(req.params.id) },
  });
  if (post == null || post.deleted_at != null) {
    return res.status(404).json({ error: "post not found" });
  }
  if (post.user_id !== userId) {
    return res.status(403).json({ error: "not your post" });
  }
  await prisma.community_post.update({
    where: { id: post.id },
    data: { deleted_at: new Date() },
  });
  res.json({ ok: true });
});

/** GET /api/mobile/community/posts/:id/comments
 *
 * Returns a flat list of comments ordered by created_at ASC, with the
 * parent_comment_id set for replies. The client rebuilds the
 * top-level → replies tree (one level deep is enough for v1).
 *
 * Deleted comments are returned with body=null + deleted=true so the
 * UI can render a "(deleted)" placeholder rather than disappearing
 * mid-thread.
 */
router.get(
  "/community/posts/:id/comments",
  optionalMobileAuth,
  async (req, res) => {
    const viewerId = req.mobileUser?.sub ?? NO_VIEWER;
    const postExists = await prisma.community_post.findFirst({
      where: { id: String(req.params.id), deleted_at: null },
      select: { id: true },
    });
    if (postExists == null) return res.status(404).json({ error: "post not found" });

    const notBlocked = await authorBlockFilter(req.mobileUser?.sub);
    const rows = await prisma.community_comment.findMany({
      where: { post_id: String(req.params.id), ...notBlocked },
      orderBy: [{ created_at: "asc" }, { id: "asc" }],
      take: COMMENT_PAGE_SIZE,
      include: {
        _count: { select: { likes: true } },
        likes: { where: { user_id: viewerId }, take: 1 },
        user: { include: { password_auth: true } },
      },
    });

    res.json({
      comments: rows.map((c) => ({
        id: c.id,
        postId: c.post_id,
        parentCommentId: c.parent_comment_id,
        body: c.deleted_at != null ? null : c.body,
        deleted: c.deleted_at != null,
        author: {
          id: c.user_id,
          username: c.user.password_auth?.username ?? null,
          isMe: c.user_id === viewerId,
        },
        createdAt: c.created_at.toISOString(),
        updatedAt: c.updated_at.toISOString(),
        likeCount: c._count.likes,
        likedByMe: c.likes.length > 0,
      })),
    });
  },
);

const createCommentSchema = zod.object({
  body: zod.string().trim().min(1).max(5_000),
  parentCommentId: zod.string().uuid().nullable().optional(),
});

/** POST /api/mobile/community/posts/:id/comments
 *
 * `parentCommentId` is optional; pass it to make the comment a reply.
 * Replies-of-replies are flattened — if the supplied parent itself has
 * a parent, we use its parent's id instead so the tree never goes
 * deeper than one level.
 */
router.post(
  "/community/posts/:id/comments",
  requireMobileAuth,
  validateRequestBody(createCommentSchema),
  async (req, res) => {
    const userId = req.mobileUser!.sub;
    const postId = String(req.params.id);
    const post = await prisma.community_post.findFirst({
      where: { id: postId, deleted_at: null },
      select: { id: true },
    });
    if (post == null) return res.status(404).json({ error: "post not found" });

    const { body, parentCommentId } = req.body as zod.infer<
      typeof createCommentSchema
    >;

    let resolvedParentId: string | null = null;
    if (parentCommentId != null) {
      const parent = await prisma.community_comment.findUnique({
        where: { id: parentCommentId },
      });
      if (parent == null || parent.post_id !== postId || parent.deleted_at != null) {
        return res.status(400).json({ error: "invalid parentCommentId" });
      }
      // Flatten one level: a reply to a reply attaches to the top-level comment.
      resolvedParentId = parent.parent_comment_id ?? parent.id;
    }

    const comment = await prisma.community_comment.create({
      data: {
        post_id: postId,
        user_id: userId,
        parent_comment_id: resolvedParentId,
        body,
      },
    });

    // A reply pings the person replied to; a top-level comment pings the post
    // author. Both, when they're the same person, would be one ping too many.
    const postRow = await prisma.community_post.findUnique({
      where: { id: postId },
      select: { user_id: true, title: true },
    });
    if (resolvedParentId != null) {
      const parent = await prisma.community_comment.findUnique({
        where: { id: resolvedParentId },
        select: { user_id: true },
      });
      if (parent != null) {
        await notify({
          userId: parent.user_id,
          actorUserId: userId,
          type: "post_reply",
          targetType: "post",
          targetId: postId,
          title: postRow?.title,
          preview: body,
        });
      }
    } else if (postRow != null) {
      await notify({
        userId: postRow.user_id,
        actorUserId: userId,
        type: "post_comment",
        targetType: "post",
        targetId: postId,
        title: postRow.title,
        preview: body,
      });
    }

    res.status(201).json({
      id: comment.id,
      postId: comment.post_id,
      parentCommentId: comment.parent_comment_id,
      body: comment.body,
      deleted: false,
      author: await authorDTO(userId, userId),
      createdAt: comment.created_at.toISOString(),
      updatedAt: comment.updated_at.toISOString(),
      likeCount: 0,
      likedByMe: false,
    });
  },
);

const updateCommentSchema = zod.object({
  body: zod.string().trim().min(1).max(5_000),
});

/** PATCH /api/mobile/community/comments/:id — author only */
router.patch(
  "/community/comments/:id",
  requireMobileAuth,
  validateRequestBody(updateCommentSchema),
  async (req, res) => {
    const userId = req.mobileUser!.sub;
    const comment = await prisma.community_comment.findUnique({
      where: { id: String(req.params.id) },
    });
    if (comment == null || comment.deleted_at != null) {
      return res.status(404).json({ error: "comment not found" });
    }
    if (comment.user_id !== userId) {
      return res.status(403).json({ error: "not your comment" });
    }
    const updated = await prisma.community_comment.update({
      where: { id: comment.id },
      data: { body: (req.body as zod.infer<typeof updateCommentSchema>).body },
    });
    res.json({ id: updated.id, body: updated.body });
  },
);

/** DELETE /api/mobile/community/comments/:id — soft-delete; author only */
router.delete(
  "/community/comments/:id",
  requireMobileAuth,
  async (req, res) => {
    const userId = req.mobileUser!.sub;
    const comment = await prisma.community_comment.findUnique({
      where: { id: String(req.params.id) },
    });
    if (comment == null || comment.deleted_at != null) {
      return res.status(404).json({ error: "comment not found" });
    }
    if (comment.user_id !== userId) {
      return res.status(403).json({ error: "not your comment" });
    }
    await prisma.community_comment.update({
      where: { id: comment.id },
      data: { deleted_at: new Date() },
    });
    res.json({ ok: true });
  },
);

/** POST /api/mobile/community/posts/:id/like — idempotent */
router.post("/community/posts/:id/like", requireMobileAuth, async (req, res) => {
  const userId = req.mobileUser!.sub;
  const post = await prisma.community_post.findFirst({
    where: { id: String(req.params.id), deleted_at: null },
    select: { id: true },
  });
  if (post == null) return res.status(404).json({ error: "post not found" });
  // Track whether this call actually added a like. The endpoint is idempotent,
  // so without this a repeat POST — or an unlike/relike cycle — would notify the
  // author again every time.
  let newlyLiked = false;
  try {
    await prisma.community_post_like.create({
      data: { post_id: post.id, user_id: userId },
    });
    newlyLiked = true;
  } catch (e) {
    if (e instanceof PrismaClientKnownRequestError && e.code === "P2002") {
      /* already liked — fall through */
    } else {
      throw e;
    }
  }
  const likeCount = await prisma.community_post_like.count({
    where: { post_id: post.id },
  });
  const likedPost = newlyLiked
    ? await prisma.community_post.findUnique({
        where: { id: post.id },
        select: { user_id: true, title: true },
      })
    : null;
  if (likedPost != null) {
    await notify({
      userId: likedPost.user_id,
      actorUserId: userId,
      type: "post_like",
      targetType: "post",
      targetId: post.id,
      title: likedPost.title,
    });
  }
  res.json({ liked: true, likeCount });
});

/** DELETE /api/mobile/community/posts/:id/like — idempotent */
router.delete(
  "/community/posts/:id/like",
  requireMobileAuth,
  async (req, res) => {
    const userId = req.mobileUser!.sub;
    await prisma.community_post_like.deleteMany({
      where: { post_id: String(req.params.id), user_id: userId },
    });
    const likeCount = await prisma.community_post_like.count({
      where: { post_id: String(req.params.id) },
    });
    res.json({ liked: false, likeCount });
  },
);

/** POST /api/mobile/community/comments/:id/like — idempotent */
router.post(
  "/community/comments/:id/like",
  requireMobileAuth,
  async (req, res) => {
    const userId = req.mobileUser!.sub;
    const comment = await prisma.community_comment.findFirst({
      where: { id: String(req.params.id), deleted_at: null },
      select: { id: true },
    });
    if (comment == null)
      return res.status(404).json({ error: "comment not found" });
    let newlyLiked = false;
    try {
      await prisma.community_comment_like.create({
        data: { comment_id: comment.id, user_id: userId },
      });
      newlyLiked = true;
    } catch (e) {
      if (e instanceof PrismaClientKnownRequestError && e.code === "P2002") {
        /* already liked — fall through */
      } else {
        throw e;
      }
    }
    const likeCount = await prisma.community_comment_like.count({
      where: { comment_id: comment.id },
    });
    const likedComment = newlyLiked
      ? await prisma.community_comment.findUnique({
          where: { id: comment.id },
          select: { user_id: true, body: true, post_id: true },
        })
      : null;
    if (likedComment != null) {
      await notify({
        userId: likedComment.user_id,
        actorUserId: userId,
        type: "comment_like",
        targetType: "post",
        targetId: likedComment.post_id,
        preview: likedComment.body,
      });
    }
    res.json({ liked: true, likeCount });
  },
);

/** DELETE /api/mobile/community/comments/:id/like — idempotent */
router.delete(
  "/community/comments/:id/like",
  requireMobileAuth,
  async (req, res) => {
    const userId = req.mobileUser!.sub;
    await prisma.community_comment_like.deleteMany({
      where: { comment_id: String(req.params.id), user_id: userId },
    });
    const likeCount = await prisma.community_comment_like.count({
      where: { comment_id: String(req.params.id) },
    });
    res.json({ liked: false, likeCount });
  },
);

/* ================================================================== *
 * AI chatbot (마이오닥 AI) — RAG proxy                                *
 *                                                                    *
 * Faithful TypeScript port of the prototype's api/chat.php. Design    *
 * rationale (RAG, not fine-tuning): the medical Q&A corpus is small,  *
 * changes as clinicians review it, and must be auditable ("답변의     *
 * 근거" 배지). Retrieval-augmented generation lets us swap the corpus  *
 * (src/assets/chat/qa_index.json) without retraining, keep the model  *
 * grounded on reviewed text, and cite the exact source item ids —     *
 * none of which a fine-tuned model would give us.                     *
 *                                                                    *
 * The endpoint keeps the API key server-side, enforces per-user +     *
 * global daily caps (cost safety), pre-filters emergency symptoms,    *
 * and logs conversations for the quality-improvement loop. All file   *
 * writes are best-effort so a counter/log failure never blocks a      *
 * reply.                                                              *
 * ================================================================== */

const CHAT_CONFIG = {
  model: process.env.CHAT_MODEL || "gemini-3.1-flash-lite",
  embeddingModel: process.env.CHAT_EMBEDDING_MODEL || "gemini-embedding-001",
  // default true unless explicitly set to "false"/"0"
  searchFallback:
    (process.env.CHAT_SEARCH_FALLBACK ?? "true").toLowerCase() !== "false" &&
    process.env.CHAT_SEARCH_FALLBACK !== "0",
  ragTopK: 8,
  perUserDailyLimit: 30,
  totalDailyLimit: 500,
  maxInputChars: 500,
  maxOutputTokens: 1400,
  maxHistoryTurns: 6,
  dataDir:
    process.env.CHAT_DATA_DIR || path.join(process.cwd(), "data", "chat"),
} as const;

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const CHAT_MOCK_MODE = !GEMINI_API_KEY;

type ChatMode =
  | "qa"
  | "general"
  | "consult"
  | "emergency"
  | "limited"
  | "error";

type ChatSource = { title: string; url: string };

type ChatResponse = {
  mode: ChatMode;
  answer: string;
  refs: string[];
  suggestions: string[];
  sources: ChatSource[];
};

/** Fixed emergency guidance — mirrors chat.php's $EMERGENCY_ANSWER. */
const EMERGENCY_ANSWER =
  "말씀하신 증상은 빠른 진료가 필요할 수 있는 신호예요.\n\n" +
  "갑작스러운 시력 저하, 심한 눈 통증, 눈앞이 번쩍이는 증상, 날파리가 갑자기 많아지는 증상, " +
  "커튼을 친 것처럼 시야가 가려지는 증상은 망막 등에 문제가 생겼을 가능성이 있어 " +
  "지체하지 말고 안과 진료를 받아보셔야 합니다.\n\n" +
  "지금 증상이 있다면 이 채팅으로 시간을 보내지 마시고, 가까운 안과 또는 응급실에 바로 문의해 주세요.";

/** Conservative emergency pre-filter — same keyword lists as chat.php. */
function isEmergencyText(q: string): boolean {
  const standalone = [
    "광시증",
    "번쩍임",
    "번쩍거려",
    "번쩍번쩍",
    "커튼처럼",
    "커튼을 친",
    "피가 나",
    "찔렀",
    "찔려",
  ];
  for (const kw of standalone) {
    if (q.includes(kw)) return true;
  }
  const trigger = ["갑자기", "급격히", "심하게", "심한"];
  const symptom = [
    "안 보",
    "안보여",
    "안 보여",
    "시력",
    "아파",
    "아프",
    "통증",
    "흐려",
    "번쩍",
    "날파리",
    "비문증",
  ];
  for (const t of trigger) {
    if (!q.includes(t)) continue;
    for (const s of symptom) {
      if (q.includes(s)) return true;
    }
  }
  return false;
}

/** Resolve a chat asset that lives under src/assets/chat. tsc does not
 *  copy non-.ts files into dist/, so we probe both the compiled layout
 *  (dist/assets/chat when running from dist/routes) and the source tree
 *  (src/assets/chat) as a fallback. */
function resolveChatAsset(filename: string): string | null {
  const candidates = [
    path.join(__dirname, "..", "assets", "chat", filename),
    path.join(__dirname, "..", "..", "assets", "chat", filename),
    path.join(__dirname, "..", "..", "src", "assets", "chat", filename),
    path.join(process.cwd(), "dist", "assets", "chat", filename),
    path.join(process.cwd(), "src", "assets", "chat", filename),
  ];
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch {
      /* ignore and try next */
    }
  }
  return null;
}

type QaIndexItem = { id: string; q: string; text: string; vec: number[] };
type QaIndex = { embedding_model?: string; dim?: number; items: QaIndexItem[] };

let qaIndexCache: QaIndex | null | undefined; // undefined = not loaded yet
let promptBaseCache: string | null | undefined;

function loadQaIndex(): QaIndex | null {
  if (qaIndexCache !== undefined) return qaIndexCache;
  const p = resolveChatAsset("qa_index.json");
  if (p == null) {
    qaIndexCache = null;
    return null;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(p, "utf8")) as QaIndex;
    qaIndexCache = Array.isArray(parsed.items) ? parsed : null;
  } catch {
    qaIndexCache = null;
  }
  return qaIndexCache;
}

function loadPromptBase(): string | null {
  if (promptBaseCache !== undefined) return promptBaseCache;
  const p = resolveChatAsset("prompt_base.txt");
  if (p == null) {
    promptBaseCache = null;
    return null;
  }
  try {
    promptBaseCache = fs.readFileSync(p, "utf8");
  } catch {
    promptBaseCache = null;
  }
  return promptBaseCache;
}

/** Gemini REST call over global fetch (Node 18+). Returns decoded body. */
async function geminiHttp(
  model: string,
  method: string,
  payload: unknown,
): Promise<{ data: any | null; httpCode: number; err: string | null; ms: number }> {
  const t0 = Date.now();
  const url =
    "https://generativelanguage.googleapis.com/v1beta/models/" +
    encodeURIComponent(model) +
    ":" +
    method;
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": GEMINI_API_KEY,
      },
      body: JSON.stringify(payload),
    });
    const ms = Date.now() - t0;
    let data: any = null;
    try {
      data = await resp.json();
    } catch {
      data = null;
    }
    return { data, httpCode: resp.status, err: null, ms };
  } catch (e) {
    return {
      data: null,
      httpCode: 0,
      err: e instanceof Error ? e.message : String(e),
      ms: Date.now() - t0,
    };
  }
}

/**
 * RAG retrieval: embed the question and pick the top-k Q&A items by
 * cosine similarity. Falls back to all items on any embedding failure
 * (identical behaviour to chat.php's retrieveItems).
 */
async function retrieveItems(
  question: string,
  index: QaIndex,
): Promise<{ items: QaIndexItem[]; ids: string[]; fallback: boolean }> {
  const items = index.items ?? [];
  const all = { items, ids: ["*all*"], fallback: true };
  if (items.length === 0) return all;

  const { data, httpCode } = await geminiHttp(
    CHAT_CONFIG.embeddingModel,
    "embedContent",
    {
      content: { parts: [{ text: question }] },
      taskType: "RETRIEVAL_QUERY",
      outputDimensionality: index.dim ?? 768,
    },
  );
  const qv: unknown = data?.embedding?.values;
  if (httpCode !== 200 || !Array.isArray(qv)) return all;
  const queryVec = qv as number[];

  // Reduced-dimensionality embeddings are not unit-normalised, so we
  // normalise the query vector here (item vectors are normalised at
  // build time).
  const norm =
    Math.sqrt(queryVec.reduce((acc, v) => acc + v * v, 0)) || 1.0;

  const scored = items.map((it, i) => {
    let dot = 0;
    const vec = it.vec;
    for (let j = 0; j < vec.length; j++) dot += vec[j] * (queryVec[j] ?? 0);
    return { i, score: dot / norm };
  });
  scored.sort((a, b) => b.score - a.score);
  const topK = scored.slice(0, Math.max(1, CHAT_CONFIG.ragTopK));

  return {
    items: topK.map((s) => items[s.i]),
    ids: topK.map((s) => `${items[s.i].id}:${s.score.toFixed(3)}`),
    fallback: false,
  };
}

type GeminiTurn = { role: "user" | "model"; parts: { text: string }[] };

/**
 * generateContent call + JSON parse. When withSearch is true the Google
 * search grounding tool is enabled (paid tier only). Mirrors
 * chat.php's callGemini.
 */
async function callGemini(
  systemPrompt: string,
  contents: GeminiTurn[],
  withSearch: boolean,
): Promise<{
  out: any | null;
  sources: ChatSource[];
  tokIn: number;
  tokOut: number;
  ms: number;
  err: string | null;
  errType: "network" | "api" | "parse" | null;
}> {
  const payload: any = {
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents,
    generationConfig: {
      temperature: 0.3,
      maxOutputTokens: CHAT_CONFIG.maxOutputTokens,
      responseMimeType: "application/json",
      responseSchema: {
        type: "OBJECT",
        properties: {
          mode: {
            type: "STRING",
            enum: ["qa", "general", "consult", "emergency"],
          },
          answer: { type: "STRING" },
          refs: { type: "ARRAY", items: { type: "STRING" } },
          suggestions: { type: "ARRAY", items: { type: "STRING" } },
        },
        required: ["mode", "answer"],
      },
    },
  };
  if (withSearch) {
    payload.tools = [{ google_search: {} }];
  }

  const ret: {
    out: any | null;
    sources: ChatSource[];
    tokIn: number;
    tokOut: number;
    ms: number;
    err: string | null;
    errType: "network" | "api" | "parse" | null;
  } = { out: null, sources: [], tokIn: 0, tokOut: 0, ms: 0, err: null, errType: null };

  const { data, httpCode, err, ms } = await geminiHttp(
    CHAT_CONFIG.model,
    "generateContent",
    payload,
  );
  ret.ms = ms;

  if (data === null) {
    ret.err = "fetch: " + (err ?? "no response");
    ret.errType = "network";
    return ret;
  }
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (httpCode !== 200 || typeof text !== "string") {
    ret.err = data?.error?.message ?? "HTTP " + httpCode;
    ret.errType = "api";
    return ret;
  }

  ret.tokIn = data?.usageMetadata?.promptTokenCount ?? 0;
  ret.tokOut = data?.usageMetadata?.candidatesTokenCount ?? 0;

  // Collect grounding sources (max 3, dedupe by uri).
  const chunks: any[] =
    data?.candidates?.[0]?.groundingMetadata?.groundingChunks ?? [];
  const seen = new Set<string>();
  for (const c of chunks) {
    const uri: string = c?.web?.uri ?? "";
    if (uri === "" || seen.has(uri) || seen.size >= 3) continue;
    seen.add(uri);
    ret.sources.push({ title: c?.web?.title ?? uri, url: uri });
  }

  // Parse model JSON — strip code fences on retry.
  let out: any = null;
  try {
    out = JSON.parse(text);
  } catch {
    const stripped = text.replace(/^```(json)?|```$/gm, "").trim();
    try {
      out = JSON.parse(stripped);
    } catch {
      out = null;
    }
  }
  if (out == null || typeof out !== "object" || out.answer == null) {
    ret.err = "json_parse: " + text.slice(0, 300);
    ret.errType = "parse";
    return ret;
  }
  ret.out = out;
  return ret;
}

/** Per-user + global daily usage cap, file-backed (usage-YYYY-MM-DD.json).
 *  Keyed by authenticated user id (not IP). Any fs failure returns "ok"
 *  so a counter problem never blocks a reply. */
function checkAndCountUsage(
  today: string,
  userId: string,
): "ok" | "user_limit" | "total_limit" {
  try {
    if (!fs.existsSync(CHAT_CONFIG.dataDir)) {
      fs.mkdirSync(CHAT_CONFIG.dataDir, { recursive: true });
    }
    const file = path.join(CHAT_CONFIG.dataDir, `usage-${today}.json`);
    let data: { total: number; users: Record<string, number> } = {
      total: 0,
      users: {},
    };
    if (fs.existsSync(file)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
        if (parsed && typeof parsed === "object") {
          data = {
            total: Number(parsed.total) || 0,
            users:
              parsed.users && typeof parsed.users === "object"
                ? parsed.users
                : {},
          };
        }
      } catch {
        /* corrupt file — start fresh */
      }
    }
    const userCount = data.users[userId] ?? 0;
    if (data.total >= CHAT_CONFIG.totalDailyLimit) return "total_limit";
    if (userCount >= CHAT_CONFIG.perUserDailyLimit) return "user_limit";
    data.total += 1;
    data.users[userId] = userCount + 1;
    fs.writeFileSync(file, JSON.stringify(data));
    return "ok";
  } catch {
    return "ok";
  }
}

/** Append a jsonl conversation log line (best-effort). */
function chatLogLine(entry: Record<string, unknown>): void {
  try {
    if (!fs.existsSync(CHAT_CONFIG.dataDir)) {
      fs.mkdirSync(CHAT_CONFIG.dataDir, { recursive: true });
    }
    const today = new Date().toISOString().slice(0, 10);
    const file = path.join(CHAT_CONFIG.dataDir, `chat-${today}.jsonl`);
    fs.appendFileSync(file, JSON.stringify(entry) + "\n");
  } catch {
    /* logging must never break a reply */
  }
}

/** Mock response (no API key) — lets the app UI work without a key.
 *  Mirrors chat.php's mockAnswer. */
function mockAnswer(q: string): ChatResponse {
  if (q.includes("아트로핀")) {
    return {
      mode: "qa",
      answer:
        "저농도 아트로핀 점안 후 눈부심은 흔히 나타나는 반응으로, 대부분 수 주 안에 적응됩니다.\n\n안약이 동공을 평소보다 크게 만들어 눈에 빛이 많이 들어오기 때문이에요. 외출할 때 모자나 선글라스를 쓰면 도움이 되고, 안약을 임의로 중단하지는 마세요.\n\n다만 눈부심이 심해 일상생활이 어렵거나 눈 통증·충혈이 함께 있다면 진료가 필요합니다.",
      refs: ["atropine-02"],
      suggestions: [
        "아트로핀은 언제까지 넣어야 하나요?",
        "안약 넣는 걸 하루 잊었으면 어떻게 하나요?",
        "아트로핀 농도는 어떻게 정해지나요?",
      ],
      sources: [],
    };
  }
  if (q.includes("드림렌즈")) {
    return {
      mode: "qa",
      answer:
        "드림렌즈(각막굴절교정렌즈)는 자는 동안 착용해 각막 모양을 살짝 눌러주는 렌즈로, 낮 동안 안경 없이 지낼 수 있게 해주고 근시 진행을 늦추는 효과가 있습니다.\n\n보통 매일 밤 6~8시간 이상 착용해야 효과가 유지됩니다. 착용을 중단하면 각막은 원래 모양으로 돌아옵니다.",
      refs: ["orthok-01"],
      suggestions: [
        "드림렌즈는 몇 살부터 할 수 있나요?",
        "드림렌즈 관리는 어떻게 하나요?",
        "드림렌즈 끼다 눈이 충혈되면 어떡하죠?",
      ],
      sources: [],
    };
  }
  return {
    mode: "general",
    answer:
      "(목업 모드) 실제 배포 시에는 이 자리에 AI가 감수 자료를 근거로 생성한 답변이 표시됩니다.\n\n지금은 API 키 없이 화면 흐름을 확인하는 시연 모드입니다.",
    refs: [],
    suggestions: [
      "아트로핀 넣고 눈부셔하는데 괜찮은가요?",
      "드림렌즈는 어떤 원리인가요?",
      "야외활동은 하루 얼마나 해야 하나요?",
    ],
    sources: [],
  };
}

const chatSchema = zod.object({
  question: zod.string(),
  history: zod
    .array(
      zod.object({
        role: zod.enum(["user", "model"]),
        text: zod.string(),
      }),
    )
    .optional(),
});

router.post(
  "/chat",
  requireMobileAuth,
  validateRequestBody(chatSchema),
  async (req, res) => {
    const userId = req.mobileUser!.sub;
    const body = req.body as zod.infer<typeof chatSchema>;
    const today = new Date().toISOString().slice(0, 10);

    const reply = (r: Partial<ChatResponse> & { mode: ChatMode; answer: string }) =>
      res.json({
        mode: r.mode,
        answer: r.answer,
        refs: r.refs ?? [],
        suggestions: r.suggestions ?? [],
        sources: r.sources ?? [],
      } satisfies ChatResponse);

    // ── Question validation ──────────────────────────────────────────
    const question = body.question.trim();
    if (question === "") {
      return reply({ mode: "error", answer: "질문을 입력해 주세요." });
    }
    if (question.length > CHAT_CONFIG.maxInputChars) {
      return reply({
        mode: "error",
        answer:
          "질문이 너무 깁니다. " +
          CHAT_CONFIG.maxInputChars +
          "자 이내로 나누어 질문해 주세요.",
      });
    }

    // ── Per-user / global daily cap ─────────────────────────────────
    const usage = checkAndCountUsage(today, userId);
    if (usage === "user_limit") {
      return reply({
        mode: "limited",
        answer:
          "오늘 이용 가능한 질문 횟수를 모두 사용하셨어요. 내일 다시 이용해 주세요. 급한 증상이 있다면 가까운 안과에 문의해 주세요.",
      });
    }
    if (usage === "total_limit") {
      return reply({
        mode: "limited",
        answer:
          "오늘 상담량이 많아 잠시 쉬어갑니다. 내일 다시 이용해 주세요. 급한 증상이 있다면 가까운 안과에 문의해 주세요.",
      });
    }

    // ── Emergency keyword pre-filter (before any LLM call) ──────────
    if (isEmergencyText(question)) {
      chatLogLine({
        ts: new Date().toISOString(),
        user: userId,
        mode: "emergency",
        filter: "keyword",
        q: question,
      });
      return reply({
        mode: "emergency",
        answer: EMERGENCY_ANSWER,
        refs: [],
        suggestions: [],
        sources: [],
      });
    }

    // ── Mock mode (no API key) — keeps the UI working without a key ──
    if (CHAT_MOCK_MODE) {
      return reply(mockAnswer(question));
    }

    // ── RAG: build systemInstruction from top-k reviewed items ──────
    const index = loadQaIndex();
    const promptBase = loadPromptBase();
    if (index == null || promptBase == null) {
      return reply({
        mode: "error",
        answer: "지금은 답변을 만들 수 없어요. 잠시 후 다시 시도해 주세요.",
      });
    }
    const rag = await retrieveItems(question, index);
    const systemPrompt =
      promptBase +
      "\n\n# 감수 자료 발췌 (질문 관련 상위 문항)\n\n" +
      rag.items.map((it) => it.text).join("\n\n---\n\n");

    // ── Build conversation contents (recent history + question) ─────
    const history = Array.isArray(body.history) ? body.history : [];
    const trimmed = history.slice(-(CHAT_CONFIG.maxHistoryTurns * 2));
    const contents: GeminiTurn[] = [];
    for (const turn of trimmed) {
      const role = turn.role === "model" ? "model" : "user";
      const text = turn.text.trim().slice(0, 2000);
      if (text === "") continue;
      contents.push({ role, parts: [{ text }] });
    }
    contents.push({ role: "user", parts: [{ text: question }] });

    // ── First pass: reviewed-corpus grounded ────────────────────────
    const r = await callGemini(systemPrompt, contents, false);
    if (r.err !== null) {
      chatLogLine({
        ts: new Date().toISOString(),
        user: userId,
        mode: "error",
        q: question,
        err: r.err.slice(0, 300),
        ms: r.ms,
      });
      return reply({
        mode: "error",
        answer:
          r.errType === "network"
            ? "AI 서버와 연결하지 못했어요. 잠시 후 다시 시도해 주세요."
            : r.errType === "parse"
              ? "답변 생성 중 문제가 있었어요. 질문을 조금 바꿔 다시 시도해 주세요."
              : "지금은 답변을 만들 수 없어요. 잠시 후 다시 시도해 주세요.",
      });
    }

    let out = r.out;
    let mode: ChatMode = ["qa", "general", "consult", "emergency"].includes(
      out.mode,
    )
      ? out.mode
      : "general";
    let sources: ChatSource[] = [];
    let searchUsed = false;
    let tokIn = r.tokIn;
    let tokOut = r.tokOut;
    let ms = r.ms;

    // ── Second pass: Google search grounding for out-of-corpus qs ───
    // On the free tier the search tool has no quota and fails; we then
    // keep the first-pass answer. Skips gracefully on any failure.
    if (mode === "general" && CHAT_CONFIG.searchFallback) {
      const r2 = await callGemini(systemPrompt, contents, true);
      if (r2.err === null && String(r2.out?.answer ?? "").trim() !== "") {
        const m2 = r2.out.mode ?? "general";
        if (["general", "consult", "emergency"].includes(m2)) {
          out = r2.out;
          mode = m2;
          sources = r2.sources;
          searchUsed = true;
          tokIn += r2.tokIn;
          tokOut += r2.tokOut;
          ms += r2.ms;
        }
      }
    }

    let answer = String(out.answer).trim();
    const refs = Array.isArray(out.refs)
      ? out.refs.map((x: unknown) => String(x)).filter((x: string) => x !== "")
      : [];
    let suggestions = Array.isArray(out.suggestions)
      ? out.suggestions
          .map((x: unknown) => String(x))
          .filter((x: string) => x !== "")
          .slice(0, 3)
      : [];

    // Emergency mode always overrides the model answer (safety double-up).
    if (mode === "emergency") {
      answer = EMERGENCY_ANSWER;
      suggestions = [];
      sources = [];
    }

    chatLogLine({
      ts: new Date().toISOString(),
      user: userId,
      mode,
      q: question,
      a: answer.slice(0, 800),
      refs,
      rag: rag.ids,
      rag_fallback: rag.fallback,
      search: searchUsed,
      tok_in: tokIn,
      tok_out: tokOut,
      ms,
    });

    return reply({ mode, answer, refs, suggestions, sources });
  },
);

/* ================================================================== *
 * Expert columns (전문가 칼럼)                                        *
 *                                                                    *
 * SEED DATA: there is no article/column table in the schema (the      *
 * existing /news route proxies PubMed live and has no persistence),   *
 * so these endpoints serve a small, self-contained set of columns     *
 * derived from the reviewed Q&A source docs shipped under             *
 * src/assets/chat/columns/*.md — one column per topic. When a real    *
 * columns table (or CMS) lands later, swap loadSeedColumns() for a    *
 * prisma query; the response shapes below are the client contract.    *
 * ================================================================== */

type ColumnListItem = {
  id: string;
  title: string;
  excerpt: string;
  category: string;
  author: string;
  authorRole: string;
  thumbnailEmoji: string;
  likeCount: number;
  commentCount: number;
  publishedAt: string;
};

type ColumnDetail = {
  id: string;
  title: string;
  body: string;
  category: string;
  author: string;
  authorRole: string;
  likeCount: number;
  commentCount: number;
  publishedAt: string;
};

// Presentation metadata per topic (order defines the feed order).
const COLUMN_TOPIC_META: {
  file: string;
  id: string;
  emoji: string;
}[] = [
  { file: "01_atropine.md", id: "atropine", emoji: "💧" },
  { file: "02_orthok.md", id: "orthok", emoji: "🌙" },
  { file: "03_myopia_lenses.md", id: "myopia_lenses", emoji: "👓" },
  { file: "04_lifestyle.md", id: "lifestyle", emoji: "☀️" },
  { file: "05_basics.md", id: "basics", emoji: "👁️" },
  { file: "06_checkup.md", id: "checkup", emoji: "📏" },
  { file: "07_emergency.md", id: "emergency", emoji: "🚨" },
];

type SeedColumn = ColumnDetail & { excerpt: string; thumbnailEmoji: string };

let seedColumnsCache: SeedColumn[] | undefined;

/** Parse the reviewed Q&A markdown docs into seed columns. */
function loadSeedColumns(): SeedColumn[] {
  if (seedColumnsCache !== undefined) return seedColumnsCache;
  const columns: SeedColumn[] = [];
  for (const meta of COLUMN_TOPIC_META) {
    const p = resolveChatAsset(path.join("columns", meta.file));
    if (p == null) continue;
    let raw: string;
    try {
      raw = fs.readFileSync(p, "utf8");
    } catch {
      continue;
    }
    // Split YAML-ish frontmatter (--- ... ---) from the body.
    let title = meta.id;
    let updated = "2026-07-05";
    let body = raw;
    const fm = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
    if (fm) {
      const front = fm[1];
      body = fm[2].trim();
      const titleMatch = front.match(/^title:\s*(.+)$/m);
      if (titleMatch) title = titleMatch[1].trim();
      const updatedMatch = front.match(/^updated:\s*(.+)$/m);
      if (updatedMatch) updated = updatedMatch[1].trim();
    }
    // 제목 앞의 [atropine-01] 같은 번호는 원고를 감수할 때 서로 가리키려고
    // 붙인 것이지 독자에게 보일 것이 아니다. 앱에서는 질문마다 대괄호 번호가
    // 먼저 읽혀서 안내문이 아니라 내부 문서처럼 보인다.
    body = body.replace(/^(#{1,6}\s*)\[[a-z0-9_-]+\]\s*/gim, "$1");

    // Excerpt: first non-heading, non-note paragraph, trimmed to ~120 chars.
    const firstPara =
      body
        .split(/\n{2,}/)
        .map((s) => s.trim())
        .find((s) => s !== "" && !s.startsWith("#") && !s.startsWith("*")) ??
      "";
    const excerpt =
      firstPara.length > 120 ? firstPara.slice(0, 120) + "…" : firstPara;
    const publishedAt = new Date(updated + "T00:00:00.000Z").toISOString();
    columns.push({
      id: meta.id,
      title,
      body,
      excerpt,
      category: meta.id,
      author: "마이오닥 의료진",
      authorRole: "안과 감수",
      thumbnailEmoji: meta.emoji,
      likeCount: 0,
      commentCount: 0,
      publishedAt,
    });
  }
  seedColumnsCache = columns;
  return columns;
}

/** GET /api/mobile/banners?placement=home — public.
 *  Active banners (within their start/end window, if set) for a placement,
 *  admin-managed via /banner (siteAdminRequired). */
router.get("/banners", async (req, res) => {
  const placement =
    typeof req.query.placement === "string" && req.query.placement.trim() !== ""
      ? req.query.placement.trim()
      : "home";
  const now = new Date();
  const rows = await prisma.ad_banner.findMany({
    where: {
      placement,
      active: true,
      OR: [{ start_at: null }, { start_at: { lte: now } }],
      AND: [{ OR: [{ end_at: null }, { end_at: { gte: now } }] }],
    },
    orderBy: [{ sort_order: "asc" }],
  });
  res.json({
    items: rows.map((b) => ({
      id: b.id,
      title: b.title,
      subtitle: b.subtitle,
      badgeText: b.badge_text,
      imageUrl: b.image_url,
      linkUrl: b.link_url,
    })),
  });
});

/** GET /api/mobile/columns?category=&cursor=&pageSize= — public.
 *  Index-based keyset cursor over the (stable-ordered) seed columns. */
router.get("/columns", (req, res) => {
  const category =
    typeof req.query.category === "string" && req.query.category.trim() !== ""
      ? req.query.category.trim()
      : null;
  const pageSize = Math.min(
    Math.max(Number.parseInt(String(req.query.pageSize ?? "20"), 10) || 20, 1),
    50,
  );

  let all = loadSeedColumns();
  if (category) all = all.filter((c) => c.category === category);

  // cursor is the id of the last item returned on the previous page.
  const cursor = typeof req.query.cursor === "string" ? req.query.cursor : null;
  let startIdx = 0;
  if (cursor) {
    const idx = all.findIndex((c) => c.id === cursor);
    startIdx = idx >= 0 ? idx + 1 : 0;
  }

  const slice = all.slice(startIdx, startIdx + pageSize);
  const nextCursor =
    startIdx + pageSize < all.length && slice.length > 0
      ? slice[slice.length - 1].id
      : null;

  const items: ColumnListItem[] = slice.map((c) => ({
    id: c.id,
    title: c.title,
    excerpt: c.excerpt,
    category: c.category,
    author: c.author,
    authorRole: c.authorRole,
    thumbnailEmoji: c.thumbnailEmoji,
    likeCount: c.likeCount,
    commentCount: c.commentCount,
    publishedAt: c.publishedAt,
  }));

  res.json({ items, nextCursor });
});

/** GET /api/mobile/columns/:id — public. */
router.get("/columns/:id", (req, res) => {
  const col = loadSeedColumns().find((c) => c.id === String(req.params.id));
  if (col == null) {
    res.status(404).json({ error: "column not found", code: "not_found" });
    return;
  }
  const detail: ColumnDetail = {
    id: col.id,
    title: col.title,
    body: col.body,
    category: col.category,
    author: col.author,
    authorRole: col.authorRole,
    likeCount: col.likeCount,
    commentCount: col.commentCount,
    publishedAt: col.publishedAt,
  };
  res.json(detail);
});

/* ------------------------------------------------------------------ *
 * Facility map (병원 찾기)                                             *
 *                                                                    *
 * GET /api/mobile/facilities?lat=&lng=&radius=                        *
 *                                                                    *
 * Public. Proxies the Kakao Local "keyword" API so we can surface     *
 * ONLY the eye-care facilities the product cares about:               *
 *   - 대학병원   → category "university"                               *
 *   - 종합병원   → category "general"                                  *
 *   - 안과의원   → category "clinic"                                   *
 *   - 안경점     → category "optical"                                  *
 *                                                                    *
 * The Naver map SDK renders the map on the client; Kakao supplies the *
 * place DATA (Naver's place search is not openly available). The REST *
 * key lives server-side in KAKAO_REST_API_KEY so it is never shipped  *
 * in the app bundle.                                                  *
 * ------------------------------------------------------------------ */

const KAKAO_REST_KEY = process.env.KAKAO_REST_API_KEY ?? "";

type FacilityCategory = "university" | "general" | "clinic" | "optical";

type FacilityDTO = {
  id: string;
  name: string;
  category: FacilityCategory;
  address: string | null;
  roadAddress: string | null;
  lat: number;
  lng: number;
  phone: string | null;
  distanceKm: number | null;
  placeUrl: string | null;
};

/** One raw Kakao keyword-search document (only the fields we use). */
type KakaoDoc = {
  id: string;
  place_name: string;
  category_name: string;
  category_group_code: string;
  phone: string;
  address_name: string;
  road_address_name: string;
  x: string; // longitude
  y: string; // latitude
  place_url: string;
  distance: string; // metres from (x,y) query centre, "" when not provided
};

/**
 * Classify a Kakao medical `category_name` (e.g.
 * "의료,건강 > 병원 > 종합병원 > 대학병원") into the finder categories.
 * Returns null for anything that is not an eye-care facility so generic
 * hospitals are filtered out. Order matters: 대학병원 is also a 종합병원.
 */
function classifyMedical(
  placeName: string,
  categoryName: string,
): FacilityCategory | null {
  // 카카오는 대학병원 안과를 그냥 "의료,건강 > 병원 > 안과" 로 준다. 분류만
  // 보면 동네 안과와 구별되지 않아 대학병원 목록이 늘 비어 있었다. 이름으로
  // 가른다 - 고려대학교안암병원 안과, 가톨릭대학교 서울성모병원 안과처럼
  // 대학 이름이 앞에 붙는다.
  if (categoryName.includes("대학병원") || /대학교|대학병원/.test(placeName)) {
    return "university";
  }
  if (categoryName.includes("종합병원")) return "general";
  if (categoryName.includes("안과")) return "clinic";
  return null;
}

/**
 * Kakao's own status, kept rather than flattened into a generic failure.
 *
 * Which number it is decides who has to fix it, and they mean very different
 * things: 401 is a bad or expired REST key, 403 is the server's IP not being on
 * the app's allow-list, 429 is quota. Collapsing all three into "upstream
 * error" meant every outage looked identical from the outside and had to be
 * diagnosed by reading server logs.
 */
class KakaoError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`kakao ${status}: ${body.slice(0, 200)}`);
    this.name = "KakaoError";
  }
}

/** What a given status means for whoever has to act on it. */
function kakaoHint(status: number): string {
  switch (status) {
    case 401:
      return "REST key rejected — wrong or expired key";
    case 403:
      return "forbidden — the server IP is probably not on the Kakao app's allow-list";
    case 429:
      return "quota exceeded for today";
    default:
      return "unexpected response from Kakao";
  }
}

/** Shared 502 body so both search endpoints report a failure the same way. */
function respondKakaoFailure(res: express.Response, err: unknown, where: string): void {
  if (err instanceof KakaoError) {
    console.error(
      `[${where}] kakao ${err.status} — ${kakaoHint(err.status)} :: ${err.body.slice(0, 300)}`,
    );
    res.status(502).json({
      error: "facility search failed",
      code: "upstream_error",
      // The upstream status and hint, not the key or the request. Enough to
      // tell whether this is ours to fix or the Kakao app owner's.
      upstreamStatus: err.status,
      hint: kakaoHint(err.status),
    });
    return;
  }
  console.error(`[${where}] kakao search failed`, err);
  res.status(502).json({ error: "facility search failed", code: "upstream_error" });
}

async function kakaoKeywordSearch(
  query: string,
  lat: number,
  lng: number,
  radius: number,
  categoryGroupCode?: string,
): Promise<KakaoDoc[]> {
  const params = new URLSearchParams({
    query,
    x: String(lng),
    y: String(lat),
    radius: String(radius),
    sort: "distance",
    size: "15",
  });
  if (categoryGroupCode) params.set("category_group_code", categoryGroupCode);

  const resp = await fetch(
    `https://dapi.kakao.com/v2/local/search/keyword.json?${params.toString()}`,
    { headers: { Authorization: `KakaoAK ${KAKAO_REST_KEY}` } },
  );
  if (!resp.ok) {
    throw new KakaoError(resp.status, await resp.text().catch(() => ""));
  }
  const data = (await resp.json()) as { documents?: KakaoDoc[] };
  return data.documents ?? [];
}

router.get("/facilities", async (req, res) => {
  if (!KAKAO_REST_KEY) {
    res
      .status(503)
      .json({ error: "facility search unavailable", code: "no_kakao_key" });
    return;
  }

  const lat = parseOptionalFloat(req.query.lat);
  const lng = parseOptionalFloat(req.query.lng);
  if (lat == null || lng == null) {
    res.status(400).json({ error: "lat and lng are required", code: "bad_request" });
    return;
  }
  // Kakao caps radius at 20 km. Hospitals are sparse, so default wide.
  const radius = Math.min(
    Math.max(parseOptionalFloat(req.query.radius) ?? 10000, 500),
    20000,
  );

  const byId = new Map<string, FacilityDTO>();
  const add = (doc: KakaoDoc, category: FacilityCategory) => {
    const dLat = Number.parseFloat(doc.y);
    const dLng = Number.parseFloat(doc.x);
    if (!Number.isFinite(dLat) || !Number.isFinite(dLng)) return;
    const existing = byId.get(doc.id);
    // Prefer the more specific medical class (university > general > clinic)
    // if the same place shows up in multiple queries. optical never collides.
    if (existing) return;
    const distM = Number.parseFloat(doc.distance);
    byId.set(doc.id, {
      id: doc.id,
      name: doc.place_name,
      category,
      address: doc.address_name || null,
      roadAddress: doc.road_address_name || null,
      lat: dLat,
      lng: dLng,
      phone: doc.phone || null,
      distanceKm: Number.isFinite(distM)
        ? Math.round((distM / 1000) * 100) / 100
        : haversineKm(lat, lng, dLat, dLng),
      placeUrl: doc.place_url || null,
    });
  };

  try {
    // Run the medical searches (HP8 = 병원) and the optical search together.
    // Medical results are classified by category_name; 안경점 is optical.
    const [univ, general, eye, optical] = await Promise.all([
      kakaoKeywordSearch("대학병원 안과", lat, lng, radius, "HP8"),
      kakaoKeywordSearch("종합병원 안과", lat, lng, radius, "HP8"),
      kakaoKeywordSearch("안과", lat, lng, radius, "HP8"),
      kakaoKeywordSearch("안경점", lat, lng, radius),
    ]);

    // Insert most-specific first so classify precedence holds on dedup.
    for (const d of univ) {
      const cls = classifyMedical(d.place_name, d.category_name);
      if (cls === "university") add(d, "university");
    }
    for (const d of general) {
      const cls = classifyMedical(d.place_name, d.category_name);
      if (cls === "university") add(d, "university");
      else if (cls === "general") add(d, "general");
    }
    for (const d of eye) {
      const cls = classifyMedical(d.place_name, d.category_name);
      if (cls) add(d, cls);
    }
    for (const d of optical) {
      // Kakao tags these as "... > 안경,콘택트렌즈 > 안경점". Guard against
      // unrelated keyword hits by requiring 안경 in the category.
      if (d.category_name.includes("안경")) add(d, "optical");
    }

    const places = Array.from(byId.values()).sort(
      (a, b) => (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity),
    );
    res.json({ places });
  } catch (err) {
    respondKakaoFailure(res, err, "facilities");
  }
});

/** Kakao keyword search without an origin point — used when the caller gave
 * a region NAME (e.g. "서울 강남구") rather than resolved coordinates, so
 * there's nothing to search "near". Results are relevance-ranked, not
 * distance-ranked. */
async function kakaoKeywordSearchByText(query: string): Promise<KakaoDoc[]> {
  const params = new URLSearchParams({ query, size: "15" });
  const resp = await fetch(
    `https://dapi.kakao.com/v2/local/search/keyword.json?${params.toString()}`,
    { headers: { Authorization: `KakaoAK ${KAKAO_REST_KEY}` } },
  );
  if (!resp.ok) throw new KakaoError(resp.status, await resp.text().catch(() => ""));
  const data = (await resp.json()) as { documents?: KakaoDoc[] };
  return data.documents ?? [];
}

/* ------------------------------------------------------------------ *
 * GET /api/mobile/treatment/hospitals?categoryKey=&sido=&sigungu=     *
 *                                                                    *
 * 치료탭 목록. 카카오를 거치지 않고 우리가 온보딩한 프로필만 돌려준다.  *
 *                                                                    *
 * 카카오로 전국 안과를 뿌리면 목록의 대부분이 이름과 주소뿐인 껍데기가  *
 * 된다 — 진료시간도 후기도 치료 가격도 우리가 등록한 병원에만 있다.     *
 * 치료탭은 "이 치료를 받을 병원을 고른다"는 자리라 알맹이 없는 행이     *
 * 섞이면 고를 수가 없다. 전국 목록이 필요하면 병원찾기 탭으로.          *
 *                                                                    *
 * 지역은 입구가 아니라 필터다. 온보딩 병원이 전국에 흩어져 있어         *
 * 지역부터 고르게 하면 대부분의 지역에서 빈 화면이 나온다.              *
 * ------------------------------------------------------------------ */

/** 시/도 표기가 갈린다("경기도" vs 카카오의 "경기", "강원특별자치도").
 *  앞 두 글자면 17개 시/도가 서로 겹치지 않게 구분된다. */
function sidoMatches(address: string, sido: string): boolean {
  return address.startsWith(sido.slice(0, 2));
}

/** 프로필에는 병원 종류 컬럼이 없다(카카오가 주던 분류였다). 이름으로
 *  가늠하고 아니면 의원 — 온보딩 대상은 대부분 안과의원이다. */
function categoryFromName(name: string): FacilityCategory {
  if (name.includes("대학교병원") || name.includes("대학병원")) return "university";
  if (name.includes("의료원") || name.includes("종합병원")) return "general";
  return "clinic";
}

/** 이 병원이 해당 치료를 하는가.
 *
 *  treatment_categories 가 정답이다. 다만 백엔드가 먼저 배포되고 병원이 아직
 *  저장을 다시 하지 않은 동안에는 비어 있을 수 있어, 그때는 예전처럼
 *  이벤트 항목의 category 로 넘어간다. 두 곳이 다 비면 그 치료는 안 하는 것이다. */
function offersCategory(
  p: { treatment_categories?: string[]; treatment_items?: unknown },
  categoryKey: string,
): boolean {
  const cats = p.treatment_categories ?? [];
  if (cats.length > 0) return cats.includes(categoryKey);
  // 아직 한 번도 저장하지 않은 프로필만 예전 방식으로 읽는다. 무조건 함께
  // 보면, 카테고리를 제대로 고른 병원도 이벤트에 붙은 카테고리로 검색에
  // 걸려 "안 하는 치료"로 노출된다.
  const items = (p.treatment_items ?? []) as { category?: string }[];
  return Array.isArray(items) && items.some((it) => it?.category === categoryKey);
}

router.get("/treatment/hospitals", async (req, res) => {
  const categoryKey = String(req.query.categoryKey ?? "").trim();
  const sido = String(req.query.sido ?? "").trim();
  const sigungu = String(req.query.sigungu ?? "").trim();

  const profiles = await prisma.hospital_profile.findMany({
    where: { status: "published" },
  });

  const reviewStats = await prisma.hospital_review.groupBy({
    by: ["kakao_place_id"],
    where: {
      kakao_place_id: { in: profiles.map((p) => p.kakao_place_id) },
      status: "visible",
    },
    _count: { _all: true },
    _avg: { rating: true },
  });
  const statByPlaceId = new Map(
    reviewStats.map((r) => [
      r.kakao_place_id,
      { count: r._count._all, avg: r._avg.rating },
    ]),
  );

  // 온보딩 규모가 수십 곳이라 메모리에서 거른다. JSON 컬럼(treatment_items)을
  // SQL로 뒤지는 것보다 읽기 쉽고, 이 크기에서는 차이도 없다.
  const rows = profiles.filter((p) => {
    const address = p.address ?? "";
    if (sido !== "" && !sidoMatches(address, sido)) return false;
    if (sigungu !== "" && sigungu !== "전체" && !address.includes(sigungu)) return false;
    if (categoryKey !== "" && !offersCategory(p, categoryKey)) return false;
    return true;
  });

  const decorated = rows.map((p) => {
    const stat = statByPlaceId.get(p.kakao_place_id);
    return {
      id: p.kakao_place_id,
      name: p.name,
      category: categoryFromName(p.name),
      address: toDistrictAddress(p.address),
      roadAddress: p.address,
      lat: p.latitude,
      lng: p.longitude,
      phone: p.phone,
      distanceKm: null,
      // 카카오 장소 상세는 place id로 바로 열린다 — 상세 화면의 "카카오맵에서
      // 보기"가 쓰는 링크라 검색 응답 없이도 만들 수 있다.
      placeUrl: `https://place.map.kakao.com/${p.kakao_place_id}`,
      partner: true,
      verified: p.verified,
      eyelogLinked: p.hospital_id != null,
      // 목록 전체가 우리가 등록한 병원이라, 뱃지는 "이 치료를 한다"가 아니라
      // 여기까지 온 이유를 확인해 주는 표시로 남는다.
      treatmentCategories: p.treatment_categories ?? [],
      offersChosen: categoryKey !== "",
      description: p.tagline ?? p.description ?? null,
      keywords: p.keywords,
      thumbnailUrl: p.thumbnail_url ?? p.images[0] ?? null,
      treatmentItems: (p.treatment_items ?? []) as unknown[],
      reviewCount: stat?.count ?? 0,
      ratingAvg: stat?.avg ?? null,
    };
  });

  // eyelog 연동 병원이 먼저.
  //
  // 노출 자격과 후기 자격은 다른 질문에 답한다. 노출은 "이 병원 정보가 쓸모
  // 있나"(= 프로필이 채워졌나)이고, 후기는 "이 사람이 진짜 환자인가"(= 진료
  // 기록이 있나)다. 노출까지 연동에 묶으면 myodoc에만 가입한 병원은 정보를
  // 아무리 채워도 보이지 않아 성장이 막힌다. 대신 연동한 병원을 위로 올리고
  // 뱃지를 달아, 연동이 장벽이 아니라 이득이 되게 한다.
  //
  // 근거 없는 우대가 아니다 - 연동 병원은 측정이 자동으로 흘러 들어오고
  // 그곳 환자만 후기를 쓸 수 있어, 실제로 더 확인된 선택지다.
  decorated.sort(
    (a, b) =>
      Number(b.eyelogLinked) - Number(a.eyelogLinked) ||
      (b.ratingAvg ?? 0) - (a.ratingAvg ?? 0) ||
      b.reviewCount - a.reviewCount ||
      a.name.localeCompare(b.name, "ko"),
  );

  res.json({ places: decorated });
});

/* ------------------------------------------------------------------ *
 * Treatment finder (치료 항목별 병원 찾기)                              *
 *                                                                    *
 * GET /api/mobile/facilities/search?keyword=&region=                  *
 *                                                                    *
 * Public. Companion to /facilities above, for the "pick a treatment,  *
 * then a region" flow instead of GPS-radius search — there's no       *
 * origin point, so this queries Kakao by region NAME + treatment      *
 * keyword text instead of x/y/radius. `region` and `keyword` are both *
 * free text (e.g. region="서울 강남구", keyword="드림렌즈") since       *
 * neither the app nor this backend has a persisted region/treatment   *
 * taxonomy — the client sends whatever label it showed the user.      *
 * ------------------------------------------------------------------ */
router.get("/facilities/search", async (req, res) => {
  if (!KAKAO_REST_KEY) {
    res
      .status(503)
      .json({ error: "facility search unavailable", code: "no_kakao_key" });
    return;
  }

  const region =
    typeof req.query.region === "string" ? req.query.region.trim() : "";
  // The treatment the user picked, e.g. "dreamLens". It decides who gets a
  // badge and who rises, NOT what we ask Kakao.
  const categoryKey =
    typeof req.query.categoryKey === "string" ? req.query.categoryKey.trim() : "";

  if (!region) {
    res.status(400).json({ error: "region is required", code: "bad_request" });
    return;
  }

  // Deliberately region + "안과" only.
  //
  // Kakao Local matches place names and categories — it has no idea which
  // clinic performs 드림렌즈. Putting the treatment in the query returned zero
  // results for every real treatment ("서울 강남구 드림렌즈 안과" → 0), which
  // emptied the screen precisely when the user had told us what they wanted.
  // Which clinics offer what is our data, not Kakao's, so the treatment is
  // applied below instead.
  const query = [region, "안과"].join(" ");

  try {
    const docs = await kakaoKeywordSearchByText(query);
    const places: FacilityDTO[] = [];
    for (const d of docs) {
      const cls = classifyMedical(d.place_name, d.category_name);
      if (!cls) continue; // not an eye-care result — drop it
      const lat = Number.parseFloat(d.y);
      const lng = Number.parseFloat(d.x);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
      places.push({
        id: d.id,
        name: d.place_name,
        category: cls,
        // 지번 주소를 동까지만. 목록은 '어디쯤인지'를 보여주는 자리라
        // 번지까지 들어가면 한 줄을 넘겨 정작 필요한 부분이 잘린다.
        address: toDistrictAddress(d.address_name),
        roadAddress: d.road_address_name || null,
        lat,
        lng,
        phone: d.phone || null,
        distanceKm: null, // no origin point to measure distance from
        placeUrl: d.place_url || null,
      });
    }

    // Join Kakao's places to our own profiles on the kakao place id, then order
    // them: clinics on the platform that offer the chosen treatment, then other
    // clinics on the platform, then everyone else in Kakao's own order.
    //
    // Kakao's ranking is kept as the base because its API exposes no rating or
    // review count to sort by — only names, addresses and coordinates.
    const profiles = await prisma.hospital_profile.findMany({
      where: { kakao_place_id: { in: places.map((p) => p.id) } },
    });
    const byPlaceId = new Map(profiles.map((p) => [p.kakao_place_id, p]));

    const reviewStats = await prisma.hospital_review.groupBy({
      by: ["kakao_place_id"],
      where: { kakao_place_id: { in: [...byPlaceId.keys()] }, status: "visible" },
      _count: { _all: true },
      _avg: { rating: true },
    });
    const statByPlaceId = new Map(
      reviewStats.map((r) => [
        r.kakao_place_id,
        { count: r._count._all, avg: r._avg.rating },
      ]),
    );

    const decorated = places.map((place, kakaoRank) => {
      const profile = byPlaceId.get(place.id);
      const offersChosen =
        categoryKey !== "" && profile != null && offersCategory(profile, categoryKey);
      const stat = statByPlaceId.get(place.id);
      return {
        ...place,
        kakaoRank,
        partner: profile != null,
        verified: profile?.verified ?? false,
        // Linked to a hospital on the clinician platform. Shown as the
        // "eyelog 연동" badge — it means measurements flow in automatically,
        // which is a stronger trust signal to a parent than anything the
        // clinic writes about itself.
        eyelogLinked: profile?.hospital_id != null,
        treatmentCategories: profile?.treatment_categories ?? [],
        offersChosen,
        description: profile?.tagline ?? profile?.description ?? null,
        keywords: profile?.keywords ?? [],
        // A clinic shouldn't have to upload the same photo twice: when no
        // thumbnail is set, the first banner is the card image.
        thumbnailUrl: profile?.thumbnail_url ?? profile?.images?.[0] ?? null,
        // The whole list, not just the match: the card shows the chosen
        // treatment's price, and the detail screen shows the rest.
        treatmentItems: (profile?.treatment_items ?? []) as unknown[],
        reviewCount: stat?.count ?? 0,
        ratingAvg: stat?.avg ?? null,
        // Tier 0 sorts first.
        tier: offersChosen ? 0 : profile != null ? 1 : 2,
      };
    });

    decorated.sort((a, b) => {
      if (a.tier !== b.tier) return a.tier - b.tier;
      // Within the platform tiers, better-reviewed clinics first. Outside them
      // there are no reviews, so Kakao's order carries.
      if (a.tier < 2) {
        const ar = a.ratingAvg ?? 0;
        const br = b.ratingAvg ?? 0;
        if (ar !== br) return br - ar;
        if (a.reviewCount !== b.reviewCount) return b.reviewCount - a.reviewCount;
      }
      return a.kakaoRank - b.kakaoRank;
    });

    res.json({ places: decorated.map(({ kakaoRank, tier, ...rest }) => rest) });
  } catch (err) {
    respondKakaoFailure(res, err, "facilities/search");
  }
});

/** GET /api/mobile/hospital-profiles/summary?placeIds=a,b,c — public batch.
 *  Card-summary data for the results list (thumbnail, keywords, rating,
 *  treatment items) keyed by kakao place id, so the list enriches every card
 *  in one round-trip instead of N. Only published profiles are returned. */
router.get("/hospital-profiles/summary", async (req, res) => {
  const raw = typeof req.query.placeIds === "string" ? req.query.placeIds : "";
  const ids = raw.split(",").map((s) => s.trim()).filter(Boolean).slice(0, 50);
  if (ids.length === 0) {
    res.json({ profiles: {} });
    return;
  }
  const [profiles, ratings] = await Promise.all([
    prisma.hospital_profile.findMany({
      where: { kakao_place_id: { in: ids }, status: "published" },
    }),
    prisma.hospital_review.groupBy({
      by: ["kakao_place_id"],
      where: { kakao_place_id: { in: ids }, status: "visible" },
      _avg: { rating: true },
      _count: { _all: true },
    }),
  ]);
  const ratingByPlace = new Map(ratings.map((r) => [r.kakao_place_id, r]));
  const out: Record<string, unknown> = {};
  for (const p of profiles) {
    const r = ratingByPlace.get(p.kakao_place_id);
    out[p.kakao_place_id] = {
      thumbnailUrl: p.thumbnail_url,
      keywords: p.keywords,
      treatmentItems: p.treatment_items ?? [],
      verified: p.verified,
      ratingAvg: r?._avg.rating ?? null,
      reviewCount: r?._count._all ?? 0,
    };
  }
  res.json({ profiles: out });
});

/** GET /api/mobile/hospital-profile/:kakaoPlaceId — public.
 *  Returns the admin/partner-managed marketing profile (banner, description,
 *  gallery) for a finder hospital, keyed to its Kakao place id. 404 when the
 *  hospital hasn't set one up (the app then just shows the basic info). */
router.get("/hospital-profile/:kakaoPlaceId", optionalMobileAuth, async (req, res) => {
  const placeId = String(req.params.kakaoPlaceId);
  const profile = await prisma.hospital_profile.findUnique({
    where: { kakao_place_id: placeId },
    include: {
      notices: {
        where: { published: true },
        // Pinned first, then newest — a clinic pins the thing it wants read.
        orderBy: [{ pinned: "desc" }, { created_at: "desc" }],
        take: 20,
      },
    },
  });
  if (profile == null || profile.status !== "published") {
    res.status(404).json({ error: "no profile", code: "not_found" });
    return;
  }
  const agg = await prisma.hospital_review.aggregate({
    where: { kakao_place_id: placeId, status: "visible" },
    _avg: { rating: true },
    _count: { _all: true },
  });
  // 연동 병원 여부는 뱃지("eyelog 연동")용이다 — 이 병원 데이터가 자동으로
  // 들어온다는 뜻이라 부모에게는 병원이 스스로 쓴 어떤 문구보다 강한 신호다.
  const eyelogLinked = profile.hospital_id != null;
  // 후기 작성 자격은 그것만으로는 부족하다. 실제로 그 병원에 다니는 아이의
  // 부모여야 등록이 통과한다(POST가 그렇게 검사한다). 여기서 같은 기준으로
  // 계산하지 않으면 자격 없는 사람에게 "후기 작성" 버튼을 보여주고 눌렀을 때
  // 403으로 돌려보내게 된다.
  const viewerId = req.mobileUser?.sub;
  const reviewable =
    viewerId != null &&
    profile.hospital_id != null &&
    (await prisma.child_hospital_link.findFirst({
      where: {
        hospital_id: profile.hospital_id,
        status: "active",
        parent_child_link: { user_id: viewerId },
      },
      select: { id: true },
    })) != null;
  res.json({
    kakaoPlaceId: profile.kakao_place_id,
    name: profile.name,
    tagline: profile.tagline,
    description: profile.description,
    detailBlocks: profile.detail_blocks ?? null,
    bannerImageUrl: profile.banner_image_url,
    thumbnailUrl: profile.thumbnail_url ?? profile.images[0] ?? null,
    images: profile.images,
    phone: profile.phone,
    address: profile.address,
    keywords: profile.keywords,
    treatmentCategories: profile.treatment_categories ?? [],
    treatmentItems: profile.treatment_items ?? [],
    verified: profile.verified,
    bookingUrl: profile.booking_url,
    reviewable,
    // Null when the clinic hasn't filled them in; the app hides the section
    // rather than showing an empty table.
    openingHours: profile.opening_hours ?? null,
    doctors: profile.doctors ?? null,
    notices: profile.notices.map((n) => ({
      id: n.id,
      title: n.title,
      body: n.body,
      kind: n.kind,
      pinned: n.pinned,
      createdAt: n.created_at.toISOString(),
    })),
    eyelogLinked,
    ratingAvg: agg._avg.rating,
    reviewCount: agg._count._all,
  });
});

/** GET /api/mobile/hospital-profile/:kakaoPlaceId/reviews — public list. */
router.get("/hospital-profile/:kakaoPlaceId/reviews", optionalMobileAuth, async (req, res) => {
  const placeId = String(req.params.kakaoPlaceId);
  const notBlocked = await authorBlockFilter(req.mobileUser?.sub);
  const reviews = await prisma.hospital_review.findMany({
    where: {
      kakao_place_id: placeId,
      status: "visible",
      ...notBlocked,
    },
    orderBy: [{ created_at: "desc" }],
    take: 100,
  });
  const me = req.mobileUser?.sub;
  // 작성자 이름은 첫 글자만. 후기가 실제 사람의 글이라는 신호는 필요한데,
  // 진료 기록과 붙어 있는 글이라 전체 이름은 노출할 것이 아니다.
  const authors = await prisma.user.findMany({
    where: { id: { in: [...new Set(reviews.map((r) => r.user_id))] } },
    include: { password_auth: true },
  });
  const nameById = new Map(
    authors.map((u) => [u.id, maskName(u.password_auth?.username ?? null)]),
  );
  res.json({
    reviews: reviews.map((r) => ({
      id: r.id,
      rating: r.rating,
      content: r.content,
      images: r.images,
      createdAt: r.created_at.toISOString(),
      isMine: me != null && r.user_id === me,
      // 차단은 글이 아니라 사람을 막는 것이라 작성자 id가 필요하다.
      // 커뮤니티 작성자 DTO도 같은 값을 내보낸다.
      authorId: r.user_id,
      authorMasked: nameById.get(r.user_id) ?? "익명",
    })),
  });
});

/** "홍길동" → "홍**". 이름이 없으면 익명. */
function maskName(name: string | null): string {
  const trimmed = (name ?? "").trim();
  if (trimmed === "") return "익명";
  return trimmed[0] + "**";
}

const reviewBodySchema = zod.object({
  rating: zod.number().int().min(1).max(5),
  content: zod.string().min(1).max(2000),
  images: zod.array(zod.string().url()).max(10).optional(),
});

/** Verify the logged-in user was actually a patient at the hospital this
 *  profile is linked to (the only way we can trust "진료 환자만"). Returns the
 *  internal hospital_id on success, or null when not eligible. */
async function eligibleHospitalId(placeId: string, userId: string): Promise<string | null> {
  const profile = await prisma.hospital_profile.findUnique({
    where: { kakao_place_id: placeId },
  });
  if (profile == null || profile.hospital_id == null) return null;
  const link = await prisma.child_hospital_link.findFirst({
    where: {
      hospital_id: profile.hospital_id,
      status: "active",
      parent_child_link: { user_id: userId },
    },
  });
  return link == null ? null : profile.hospital_id;
}

/** POST /api/mobile/hospital-profile/:kakaoPlaceId/reviews — patients only. */
router.post(
  "/hospital-profile/:kakaoPlaceId/reviews",
  requireMobileAuth,
  async (req, res) => {
    const placeId = String(req.params.kakaoPlaceId);
    const parsed = reviewBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid body", code: "bad_request" });
      return;
    }
    const userId = req.mobileUser!.sub;
    const hospitalId = await eligibleHospitalId(placeId, userId);
    if (hospitalId == null) {
      res.status(403).json({ error: "not a verified patient", code: "not_eligible" });
      return;
    }
    const d = parsed.data;
    let review;
    try {
      review = await prisma.hospital_review.create({
        data: {
          kakao_place_id: placeId,
          user_id: userId,
          hospital_id: hospitalId,
          rating: d.rating,
          content: d.content,
          images: d.images ?? [],
        },
      });
    } catch (e) {
      // Only a unique-constraint hit means "already reviewed" — anything else
      // is a real failure and must not be masked as a 409.
      if (e instanceof PrismaClientKnownRequestError && e.code === "P2002") {
        res.status(409).json({ error: "already reviewed", code: "duplicate" });
        return;
      }
      throw e;
    }
    res.status(201).json({ id: review.id });
  },
);

/* 후기 수정은 없다.
 *
 * 후기는 특정 시점의 진료 경험에 대한 진술이고, 나중에 내용을 바꿀 수 있으면
 * 그 진술이 언제의 것인지 읽는 사람이 알 수 없게 된다. 병원이 사후에 수정을
 * 요구할 여지도 생긴다. 고칠 것이 있으면 지우고 다시 쓴다(한 병원당 한 건).
 * 수정 엔드포인트는 그래서 두지 않는다 — 화면에 없더라도 열려 있으면 정책이
 * 아니라 장식이다. */

/** DELETE /api/mobile/hospital-profile/:kakaoPlaceId/reviews/:id — own review. */
router.delete(
  "/hospital-profile/:kakaoPlaceId/reviews/:id",
  requireMobileAuth,
  async (req, res) => {
    const id = String(req.params.id);
    const userId = req.mobileUser!.sub;
    const existing = await prisma.hospital_review.findUnique({ where: { id } });
    if (
      existing == null ||
      existing.user_id !== userId ||
      existing.kakao_place_id !== String(req.params.kakaoPlaceId)
    ) {
      res.sendStatus(404);
      return;
    }
    await prisma.hospital_review.delete({ where: { id } });
    res.sendStatus(204);
  },
);

/* ------------------------------------------------------------------ *
 * Treatment comparison (근시 치료법 비교)                              *
 *                                                                    *
 * GET /api/mobile/treatments — public. Single source of truth for the *
 * educational "myopia treatment comparison" content, shared by the    *
 * web portal and the app so the two never drift. Content is bilingual *
 * (ko/en); the client renders whichever matches its current language. *
 *                                                                    *
 * Ported verbatim from the web's former static file                   *
 * (myopia/src/data/treatments.ts). To edit copy, change it HERE and    *
 * both surfaces update.                                                *
 * ------------------------------------------------------------------ */

type TreatmentText = {
  title: string;
  shortDescription: string;
  longDescription: string;
  mechanism: string;
  efficacy: string;
};

type TreatmentItem = {
  id: string;
  emoji: string;
  imageUrl: string;
  ko: TreatmentText;
  en: TreatmentText;
};

const TREATMENTS: TreatmentItem[] = [
  {
    id: "atropine",
    emoji: "💧",
    imageUrl: "/atropine.png",
    en: {
      title: "Low Dose Atropine",
      shortDescription:
        "Eye drops that slow eye growth by affecting retinal and scleral signaling.",
      longDescription:
        "Low Dose Atropine is a pharmacological treatment used to control myopia progression. Unlike the high concentrations used for dilation (1%), low doses (0.01%, 0.05%) minimize side effects while maintaining efficacy. It is often the first line of defense for progressive myopia in children.",
      mechanism:
        "The exact mechanism is complex, but it is believed that atropine acts as a non-selective muscarinic antagonist. It does not control myopia by stopping accommodation (focusing) as previously thought. instead, it influences signaling pathways in the retina and choroid (the vascular layer of the eye). This signaling cascade ultimately instructs the sclera (the white outer coting) to reduce its remodeling and stretching, thereby slowing down the axial elongation of the eyeball.",
      efficacy:
        "Clinical trials like the LAMP (Low-concentration Atropine for Myopia Progression) study have shown profound results. 0.05% atropine has been shown to reduce myopia progression by approximately 67% compared to placebo over two years. Even 0.01% concentrations offer significant benefits, reducing progression by about 27-50% in various studies. It is particularly effective when started early.",
    },
    ko: {
      title: "저농도아트로핀",
      shortDescription:
        "망막과 공막의 신호전달에 작용하여 안구 성장을 늦추는 점안약입니다.",
      longDescription:
        "저농도아트로핀은 근시 진행을 조절하기 위해 사용되는 약물 치료입니다. 산동에 쓰이는 고농도(1%)와 달리, 저농도(0.01%, 0.05%)는 효과를 유지하면서 부작용을 최소화합니다. 소아의 진행성 근시에서 흔히 1차 치료로 사용됩니다.",
      mechanism:
        "정확한 기전은 복잡하지만, 아트로핀은 비선택적 무스카린 길항제로 작용하는 것으로 알려져 있습니다. 과거의 생각과 달리 조절(초점 맞추기)을 멈춰서 근시를 조절하는 것이 아니라, 망막과 맥락막(눈의 혈관층)의 신호전달 경로에 영향을 줍니다. 이 신호 전달이 결국 공막(눈의 흰 외막)의 재형성과 늘어남을 줄이도록 하여 안구의 축성 성장(안축장 증가)을 늦춥니다.",
      efficacy:
        "LAMP(저농도 아트로핀 근시 진행 억제) 연구와 같은 임상시험에서 뚜렷한 결과가 확인되었습니다. 0.05% 아트로핀은 2년간 위약 대비 근시 진행을 약 67% 줄이는 것으로 나타났습니다. 0.01% 농도도 여러 연구에서 진행을 약 27~50% 줄이는 유의한 효과를 보였습니다. 특히 조기에 시작할수록 효과적입니다.",
    },
  },
  {
    id: "dims",
    emoji: "👓",
    imageUrl: "/dims.png",
    en: {
      title: "DIMS Spectacles (MiYOSMART)",
      shortDescription:
        "Specialized eyeglass lenses with hundreds of honeycomb segments to reduce eye growth.",
      longDescription:
        "Defocus Incorporated Multiple Segments (DIMS) technology is a breakthrough in spectacle lens design. These lenses look like regular glasses but contain a central clear zone for sharp vision and a peripheral treatment zone with a honeycomb pattern of tiny lenslets.",
      mechanism:
        "DIMS lenses work on the principle of 'Peripheral Myopic Defocus'. In standard glasses, peripheral light often focuses behind the retina (hyperopic defocus), which stimulates the eye to grow longer to 'catch up' to the image. DIMS lenses project light in the mid-periphery in front of the retina (myopic defocus). This acts as a powerful 'stop signal' to the eye, inhibiting axial elongation while allowing the child to see clearly through the central optical zone.",
      efficacy:
        "Randomized controlled trials have demonstrated exceptional efficacy. Studies indicate that DIMS lenses can slow myopia progression by 52% and reduce axial length elongation by 62% on average compared to single-vision lenses. The effect is sustained over multiple years of wear, making it a highly effective non-invasive option.",
    },
    ko: {
      title: "DIMS안경 (MiYOSMART)",
      shortDescription:
        "수백 개의 벌집 모양 미세 렌즈 조각으로 안구 성장을 줄이는 특수 안경 렌즈입니다.",
      longDescription:
        "DIMS(Defocus Incorporated Multiple Segments) 기술은 안경 렌즈 설계의 획기적인 발전입니다. 겉보기에는 일반 안경과 같지만, 선명한 시력을 위한 중심부 투명 구역과 벌집 패턴의 미세 렌즈들이 배열된 주변부 치료 구역으로 구성됩니다.",
      mechanism:
        "DIMS 렌즈는 '주변부 근시성 흐림(Peripheral Myopic Defocus)' 원리로 작동합니다. 일반 안경에서는 주변부 빛이 망막 뒤에 초점을 맺는 경우가 많아(원시성 흐림) 눈이 상을 '따라잡기' 위해 더 길게 자라도록 자극받습니다. DIMS 렌즈는 중간 주변부의 빛을 망막 앞에 맺히게 하여(근시성 흐림) 안구 성장에 강력한 '정지 신호'를 보내고, 동시에 중심 광학부를 통해 선명하게 볼 수 있게 합니다.",
      efficacy:
        "무작위 대조 시험에서 우수한 효과가 입증되었습니다. 연구에 따르면 DIMS 렌즈는 단초점 렌즈 대비 근시 진행을 평균 52%, 안축장 증가를 62% 늦출 수 있습니다. 이 효과는 수년간 착용해도 유지되어, 매우 효과적인 비침습 치료 옵션입니다.",
    },
  },
  {
    id: "orthok",
    emoji: "🌙",
    imageUrl: "/orthok.png",
    en: {
      title: "Orthokeratology (Ortho-K)",
      shortDescription:
        "Rigid contact lenses worn overnight to reshape the cornea and correct vision.",
      longDescription:
        "Orthokeratology, or Ortho-K, involves wearing custom-designed rigid gas permeable contact lenses while sleeping. These lenses gently reshape the front surface of the eye (cornea) overnight, allowing the user to be glass-free during the day.",
      mechanism:
        "Ortho-K corrects myopia by flattening the central cornea, providing clear daytime vision. For myopia control, the key is the mid-peripheral fluid reservoir created by the lens shape. This steepens the mid-peripheral cornea, which, similar to DIMS, focuses peripheral light in front of the retina (peripheral myopic defocus). This optical signal suppresses the stimulus for eye growth.",
      efficacy:
        "Ortho-K is one of the most established methods for myopia control. It consistently demonstrates a slowing of axial elongation by approximately 45-50% compared to spectacles. It is particularly beneficial for active children who want to be free of glasses during sports and daily activities.",
    },
    ko: {
      title: "드림렌즈",
      shortDescription:
        "밤에 착용하여 각막 형태를 교정해 시력을 회복시키는 하드 콘택트렌즈입니다.",
      longDescription:
        "드림렌즈(각막굴절교정렌즈, Ortho-K)는 수면 중에 맞춤 설계된 산소투과성 하드렌즈를 착용하는 치료입니다. 렌즈가 밤사이 눈의 앞면(각막)을 부드럽게 재형성하여 낮 동안 안경 없이 생활할 수 있게 합니다.",
      mechanism:
        "드림렌즈는 중심부 각막을 평평하게 만들어 낮 동안 선명한 시력을 제공합니다. 근시 억제의 핵심은 렌즈 형태가 만들어내는 중간 주변부의 눈물층입니다. 이로 인해 중간 주변부 각막이 가팔라지고, DIMS와 유사하게 주변부 빛을 망막 앞에 맺히게 하여(주변부 근시성 흐림) 안구 성장 자극을 억제합니다.",
      efficacy:
        "드림렌즈는 근시 억제에서 가장 오래 검증된 방법 중 하나입니다. 안경 대비 안축장 증가를 일관되게 약 45~50% 늦추는 것으로 보고됩니다. 특히 운동이나 일상생활에서 안경 없이 지내고 싶어 하는 활동적인 아이들에게 유용합니다.",
    },
  },
  {
    id: "halt",
    emoji: "✨",
    imageUrl: "/halt.png",
    en: {
      title: "HALT Technology (Stellest)",
      shortDescription:
        "Lenses with concentric rings of aspherical lenslets to create a volume of myopic defocus.",
      longDescription:
        "Highly Aspherical Lenslet Target (HALT) technology represents the newest generation of myopia control spectacle lenses. It uses a constellation of aspherical lenslets arranged in concentric rings.",
      mechanism:
        "Unlike DIMS which uses distinct focal points, HALT technology creates a 'Volume of Myopic Defocus'. The aspherical lenslets create a continuous signal of light in front of the retina that follows the curvature of the eye. This 3D volume of signal is hypothesized to be a stronger stop signal for eye growth than a single plane of defocus. It keeps the myopia control signal on the retina regardless of eye movement.",
      efficacy:
        "Clinical results for HALT lenses are impressive. A two-year clinical trial showed that when worn for at least 12 hours a day, HALT lenses slowed myopia progression by 67% and axial elongation by 60% compared to single-vision lenses. It is highly comparable to high-dose atropine in efficacy but without the side effects.",
    },
    ko: {
      title: "에실로 스텔리스트 렌즈",
      shortDescription:
        "비구면 미세 렌즈들을 동심원 고리로 배열하여 근시성 흐림의 입체 볼륨을 만드는 렌즈입니다.",
      longDescription:
        "HALT(Highly Aspherical Lenslet Target) 기술은 최신 세대의 근시 억제 안경 렌즈입니다. 동심원 고리 형태로 배열된 비구면 미세 렌즈들의 배열을 사용합니다.",
      mechanism:
        "뚜렷한 초점들을 사용하는 DIMS와 달리, HALT 기술은 '근시성 흐림의 입체 볼륨(Volume of Myopic Defocus)'을 만듭니다. 비구면 미세 렌즈들이 안구 곡률을 따라 망막 앞에 연속적인 빛 신호를 형성합니다. 이 3차원 신호 볼륨은 단일 평면의 흐림보다 더 강한 성장 정지 신호로 작용하는 것으로 추정되며, 눈이 움직여도 근시 억제 신호가 망막 위에 유지됩니다.",
      efficacy:
        "임상 결과는 인상적입니다. 2년 임상시험에서 하루 12시간 이상 착용 시 단초점 렌즈 대비 근시 진행을 67%, 안축장 증가를 60% 늦추는 것으로 나타났습니다. 효과 면에서 고농도 아트로핀에 필적하면서도 그 부작용이 없습니다.",
    },
  },
];

// GET /api/mobile/treatments — bilingual treatment comparison content.
router.get("/treatments", (_req, res) => {
  res.json({ items: TREATMENTS });
});

export default router;
