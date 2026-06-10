import express from "express";
import bcrypt from "bcrypt";
import prisma from "../lib/prisma";

import { generateSession, getAuthSession } from "../lib/session";
import { PrismaClientKnownRequestError } from "@prisma/client/runtime/library";
import { loginRequired, validateRequestBody } from "../lib/middlewares";
import { CONSENT_VERSION } from "../lib/consent";

import { OAuth2Client } from "google-auth-library";

import zod from "zod";

const client = new OAuth2Client();

// Builds the nested user_consent rows recorded at signup. Required consents
// (terms / privacy) are enforced as `true` by the zod schema; marketing is
// optional and mirrored into user.receive_email_updates.
function signupConsentRows(agreeMarketing: boolean) {
  return [
    {
      consent_type: "terms_of_service" as const,
      version: CONSENT_VERSION,
      agreed: true,
    },
    {
      consent_type: "privacy_policy" as const,
      version: CONSENT_VERSION,
      agreed: true,
    },
    {
      consent_type: "marketing" as const,
      version: CONSENT_VERSION,
      agreed: agreeMarketing,
    },
  ];
}

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

  bcrypt.compare(password, auth.hash).then((match) => {
    if (match)
      generateSession(auth.user.id)
        .then((session) => res.json(session))
        .catch(() => res.sendStatus(500));
    else res.status(401).json({ message: "Invalid username or password" });
  });
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

  generateSession(googleAuth.user.id)
    .then((session) => res.json(session))
    .catch(() => res.sendStatus(500));
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
        data: signupConsentRows(agreeMarketing).map((row) => ({
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
            create: signupConsentRows(receive_email_updates),
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
            create: signupConsentRows(receive_email_updates),
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
