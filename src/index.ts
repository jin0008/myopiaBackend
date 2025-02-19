import express, { ErrorRequestHandler } from "express";
import bodyParser from "body-parser";
import cookieParser from "cookie-parser";
import cors from "cors";

import authRoutes from "./routes/auth";
import healthcareProfessionalRoutes from "./routes/healthcare_professional";
import measurementRoutes from "./routes/measurement";
import patientRoutes from "./routes/patient";
import userRoutes from "./routes/user";

import { PrismaClientKnownRequestError } from "@prisma/client/runtime/library";
import { Prisma } from "@prisma/client";

const app = express();

declare global {
  namespace Express {
    interface Request {
      authSession: Prisma.sessionGetPayload<{}>;
      healthcare_professional: Prisma.healthcare_professionalGetPayload<{}>;
    }
  }
}

app.use(cookieParser());
app.use(bodyParser.json());
app.use(cors());

app.use("/auth", authRoutes);
app.use("/healthcare_professional", healthcareProfessionalRoutes);
app.use("/measurement", measurementRoutes);
app.use("/patient", patientRoutes);
app.use("/user", userRoutes);

const prismaErrorHandler: ErrorRequestHandler = (err, req, res, next) => {
  if (err instanceof PrismaClientKnownRequestError) {
    if (["P2002", "P2004", "P2006", "P2007"].includes(err.code)) {
      console.log(err.message);
      res.sendStatus(400);
      return;
    }
  }
  next(err);
};

const globalErrorHandler: ErrorRequestHandler = (err, req, res, next) => {
  console.error(err);
  res.sendStatus(500);
};

app.use(prismaErrorHandler);
app.use(globalErrorHandler);

app.listen(3000, () => console.log("Listening on port 3000"));
