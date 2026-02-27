import { RequestHandler } from "express";
import prisma from "./prisma";
import { WrongArgumentsMessage, getAuthSession, refreshSession } from "./util";
import { ZodType } from "zod";
import express from "express";

export function validateRequestBody(schema: ZodType) {
  return (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    schema
      .parseAsync(req.body, {})
      .then((result) => {
        req.body = result;
        next();
      })
      .catch(() => {
        res.status(400).json(WrongArgumentsMessage);
      });
  };
}

export const loginRequired: RequestHandler = async (req, res, next) => {
  const authSession = await getAuthSession(req);
  if (authSession == null) {
    res.sendStatus(401);
    return;
  }
  refreshSession(authSession.id);
  req.authSession = authSession;
  next();
};

export const approvedProfessionalRequired = express.Router();

approvedProfessionalRequired.use(loginRequired);

approvedProfessionalRequired.use(async (req, res, next) => {
  const approved_healthcare_professional =
    await prisma.healthcare_professional.findUnique({
      where: {
        user_id: req.authSession!.user_id,
        approved: true,
      },
    });

  if (approved_healthcare_professional == null) {
    res.sendStatus(403);
  } else {
    req.healthcare_professional = approved_healthcare_professional;
    next();
  }
});

export const hospitalAdminRequired = express.Router();

hospitalAdminRequired.use(loginRequired);

hospitalAdminRequired.use(async (req, res, next) => {
  const healthcare_professional =
    await prisma.healthcare_professional.findUnique({
      where: {
        user_id: req.authSession!.user_id,
        is_admin: true,
      },
    });

  if (healthcare_professional == null) {
    res.sendStatus(403);
  } else {
    req.healthcare_professional = healthcare_professional;
    next();
  }
});

export const siteAdminRequired = express.Router();

siteAdminRequired.use(loginRequired);

siteAdminRequired.use(async (req, res, next) => {
  const user = await prisma.user.findUnique({
    where: {
      id: req.authSession!.user_id,
    },
  });

  if (user == null || user.is_site_admin == false) {
    res.sendStatus(403);
  } else {
    next();
  }
});
