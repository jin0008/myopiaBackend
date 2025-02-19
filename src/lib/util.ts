import prisma from "./prisma";
import crypto from "crypto";
import express from "express";

const sessionLengthMillis = 1000 * 60 * 60 * 3;

export function getAuthSession(req: express.Request) {
  const authorization = req.get("Authorization");
  if (authorization == null) return null;
  const splits = authorization.split(" ");
  if (splits[0] !== "Bearer" || !splits[1]) return null;

  const session_key = splits[1];

  return prisma.session
    .findUnique({
      where: {
        session_key: session_key,
      },
    })
    .then((result) => {
      if (result == null) return null;
      if (result.valid_until < new Date()) {
        prisma.session
          .delete({
            where: {
              session_key: session_key,
            },
          })
          .catch(() => {});

        return null;
      } else return result;
    });
}

export function generateSession(userId: string) {
  const session_key = crypto.randomBytes(48).toString("hex");
  const valid_until = new Date(Date.now() + sessionLengthMillis);

  return prisma.session.create({
    data: {
      session_key: session_key,
      valid_until: valid_until,
      user_id: userId,
    },
  });
}

function clearSession(userId: string) {
  return prisma.session.deleteMany({
    where: {
      user_id: userId,
    },
  });
}
