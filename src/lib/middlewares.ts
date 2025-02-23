import { RequestHandler } from "express";
import prisma from "./prisma";
import { getAuthSession, refreshSession } from "./util";

export const loginRequired: RequestHandler = async (req, res, next) => {
  const authSession = await getAuthSession(req);
  if (authSession == null) {
    res.sendStatus(401);
  } else {
    refreshSession(authSession.id);
    req.authSession = authSession;
    next();
  }
};

export const approvedProfessionalRequired: RequestHandler = async (
  req,
  res,
  next
) => {
  const healthcare_professional =
    await prisma.healthcare_professional.findUnique({
      where: {
        user_id: req.authSession.user_id,
        approved: true,
      },
    });

  if (healthcare_professional == null) {
    res.sendStatus(403);
  } else {
    req.healthcare_professional = healthcare_professional;
    next();
  }
};
