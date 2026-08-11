import "dotenv/config";

import express, { ErrorRequestHandler } from "express";
import bodyParser from "body-parser";
import cookieParser from "cookie-parser";
import cors from "cors";
import helmet from "helmet";

import authRoutes from "./routes/auth";
import healthcareProfessionalRoutes from "./routes/healthcare_professional";
import measurementRoutes from "./routes/measurement";
import refractiveErrorRoutes from "./routes/refractive_error";
import patientRoutes from "./routes/patient";
import userRoutes from "./routes/user";
import hospitalRoutes from "./routes/hospital";
import patientTreatmentRoutes from "./routes/patient_treatment";
import staticRoutes from "./routes/static";
import growthDataRoutes from "./routes/growth_data";
import patientKRoutes from "./routes/patient_k";
import newsRoutes from "./routes/news";
import auditLogRoutes from "./routes/audit_log";
import alertRecipientRoutes from "./routes/alert_recipient";
import studyRoutes from "./routes/study";
import alertSettingRoutes from "./routes/alert_setting";
import mobileRoutes from "./routes/mobile";
import columnRoutes from "./routes/column";
import bannerRoutes from "./routes/banner";
import hospitalProfileRoutes from "./routes/hospital_profile";
import partnerRoutes from "./routes/partner";

import { authLimiter } from "./lib/security";

import { PrismaClientKnownRequestError } from "@prisma/client/runtime/library";
import { Prisma } from "@prisma/client";
import { decryptSymmetric, encryptSymmetric } from "./services/encrpytion";

const app = express();

// Behind the nginx reverse proxy: trust the first proxy hop so req.ip is the
// real client IP (from X-Forwarded-For). Required for per-client rate limiting.
app.set("trust proxy", 1);

declare global {
  namespace Express {
    interface Request {
      authSession?: Prisma.sessionGetPayload<{}>;
      healthcare_professional?: Prisma.healthcare_professionalGetPayload<{}>;
    }
  }
}

app.use(cookieParser());
app.use(bodyParser.json());
app.use(cors());
app.use(
  helmet({
    // The API is consumed cross-origin (mobile app + myopiamanage.org web),
    // so relax CORP.
    crossOriginResourcePolicy: { policy: "cross-origin" },

    // nginx already adds these four headers to every response, including
    // /api (see docs/nginx-security-headers.conf). Leaving them enabled here
    // sent each one twice and produced two conflicting Referrer-Policy values
    // (helmet "no-referrer" vs nginx "strict-origin-when-cross-origin").
    // nginx is the single source of truth for them. Every other helmet header
    // (COOP, Origin-Agent-Cluster, X-Download-Options, hidePoweredBy, ...)
    // stays at its secure default.
    strictTransportSecurity: false,
    xFrameOptions: false,
    xContentTypeOptions: false,
    referrerPolicy: false,
  }),
);

// Brute-force protection on authentication endpoints (see lib/security.ts).
// Mounted before the routers so they run first for these specific paths.
app.use("/auth/passwordLogin", authLimiter);
app.use("/auth/googleLogin", authLimiter);
app.use("/api/mobile/auth/login", authLimiter);

app.use("/auth", authRoutes);
app.use("/healthcare_professional", healthcareProfessionalRoutes);
app.use("/measurement", measurementRoutes);
app.use("/refractive_error", refractiveErrorRoutes);
app.use("/patient_k", patientKRoutes);
app.use("/patient", patientRoutes);
app.use("/user", userRoutes);
app.use("/hospital", hospitalRoutes);
app.use("/patient_treatment", patientTreatmentRoutes);
app.use("/growth_data", growthDataRoutes);
app.use("/static", staticRoutes);
app.use("/news", newsRoutes);
app.use("/audit_log", auditLogRoutes);
app.use("/alert_recipient", alertRecipientRoutes);
app.use("/study", studyRoutes);
app.use("/alert_setting", alertSettingRoutes);
app.use("/column", columnRoutes);
app.use("/banner", bannerRoutes);
app.use("/hospital-profile", hospitalProfileRoutes);
app.use("/partner", partnerRoutes);
app.use("/api/mobile", mobileRoutes);

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
