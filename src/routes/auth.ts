import express from "express";
import bcrypt from "bcrypt";
import prisma from "../lib/prisma";

import { generateSession, getAuthSession } from "../lib/util";
import { PrismaClientKnownRequestError } from "@prisma/client/runtime/library";
import { loginRequired } from "../lib/middlewares";

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
      healthcare_professional: true,
      normal_user: true,
    },
  });
  res.json(data);
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
    res.status(400).json({ message: "Invalid username or password" });
    return;
  }

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

//TODO
router.put("/user/:userId/passwordAuth", loginRequired, async (req, res) => {
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
