import express from "express";
import bcrypt from "bcrypt";
import crypto from "crypto";
import prisma from "../lib/prisma";

import { generateSession, getAuthSession } from "../lib/util";

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
    res.sendStatus(401);
    return;
  }

  bcrypt.compare(password, auth.hash).then((match) => {
    if (match)
      generateSession(auth.user.id)
        .then((session) => res.json(session))
        .catch(() => res.sendStatus(500));
    else res.sendStatus(401);
  });
});

router.post("/user/passwordAuth", async (req, res) => {
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

  const hash = await bcrypt.hash(password, 12);

  await prisma.user.create({
    data: {
      password_auth: {
        create: {
          username: username,
          hash: hash,
        },
      },
    },
  });

  res.sendStatus(200);
});

router.put("/user/:userId/passwordAuth", async (req, res) => {
  const authSession = await getAuthSession(req);
  if (authSession == null) {
    res.sendStatus(401);
    return;
  }

  if (authSession?.user_id !== req.params.userId) {
    res.sendStatus(403);
    return;
  }

  const password = req.body.password;

  if (typeof password !== "string") {
    res.sendStatus(400);
    return;
  }

  const hash = await bcrypt.hash(password, 12);

  prisma.password_auth
    .update({
      where: {
        user_id: req.body.user_id,
      },
      data: {
        hash: hash,
      },
    })
    .then(() => res.sendStatus(200));
});

export default router;
