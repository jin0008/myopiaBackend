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
  const approved_healthcare_professional =
    await prisma.healthcare_professional.findUnique({
      where: {
        user_id: req.authSession.user_id,
        approved: true,
      },
    });

  if (approved_healthcare_professional == null) {
    res.sendStatus(403);
  } else {
    req.healthcare_professional = approved_healthcare_professional;
    next();
  }
};

export const hospitalAdminRequired: RequestHandler = async (req, res, next) => {
  const healthcare_professional =
    await prisma.healthcare_professional.findUnique({
      where: {
        user_id: req.authSession.user_id,
        is_admin: true,
      },
    });

  if (healthcare_professional == null) {
    res.sendStatus(403);
  } else {
    req.healthcare_professional = healthcare_professional;
    next();
  }
};

export const siteAdminRequired: RequestHandler = async (req, res, next) => {
  const user = await prisma.user.findUnique({
    where: {
      id: req.authSession.user_id,
    },
  });

  if (user == null || user.is_site_admin == false) {
    res.sendStatus(403);
  } else {
    next();
  }
};
