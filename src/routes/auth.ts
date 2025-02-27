import express from "express";
import bcrypt from "bcrypt";
import prisma from "../lib/prisma";

import { generateSession, getAuthSession } from "../lib/util";
import { PrismaClientKnownRequestError } from "@prisma/client/runtime/library";
import { loginRequired } from "../lib/middlewares";

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
      id: req.authSession.id,
    },
  });
  res.sendStatus(200);
});

router.get("/user", loginRequired, async (req, res) => {
  const data = await prisma.user.findUnique({
    where: {
      id: req.authSession.user_id,
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
    },
  });
  res.json(data);
});

const passwordAuthType = zod.object({
  username: zod.string().nonempty(),
  password: zod.string().nonempty(),
});

router.post("/user/passwordAuth", async (req, res) => {
  let data;
  try {
    data = passwordAuthType.parse(req.body);
  } catch {
    res.status(400).json({ message: "Invalid username or password" });
    return;
  }

  const { username, password } = data;

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
});

router.post("/passwordAuth", loginRequired, async (req, res) => {
  let data;

  try {
    data = passwordAuthType.parse(req.body);
  } catch {
    res.sendStatus(400);
    return;
  }

  const { username, password } = data;
  const hash = await bcrypt.hash(password, 12);

  const passwordAuthExists = await prisma.password_auth
    .count({
      where: {
        user_id: req.authSession.user_id,
      },
    })
    .then((count) => count > 0);

  if (passwordAuthExists) {
    res.status(400).json({ message: "Password auth already exists" });
    return;
  }

  prisma.password_auth
    .create({
      data: {
        user: {
          connect: {
            id: req.authSession.user_id,
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
});

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

router.post("/user/googleAuth", async (req, res) => {
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

  await prisma.user
    .create({
      data: {
        google_auth: {
          create: {
            google_identity: payload.sub,
          },
        },
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
        user_id: req.authSession.user_id,
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
            id: req.authSession.user_id,
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
        user_id: req.authSession.user_id,
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
        user_id: req.authSession.user_id,
      },
    })
    .then(() => res.sendStatus(200));
});

router.delete("/passwordAuth", loginRequired, async (req, res) => {
  const googleAuthExists = await prisma.google_auth
    .count({
      where: {
        user_id: req.authSession.user_id,
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
        user_id: req.authSession.user_id,
      },
    })
    .then(() => res.sendStatus(200));
});

export default router;
