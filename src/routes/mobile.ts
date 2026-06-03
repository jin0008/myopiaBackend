import express from "express";
import bcrypt from "bcrypt";
import zod from "zod";
import { PrismaClientKnownRequestError } from "@prisma/client/runtime/library";
import { sex as SexEnum, myopia_status as MyopiaStatusEnum } from "@prisma/client";

import prisma from "../lib/prisma";
import { validateRequestBody } from "../lib/middlewares";
import {
  issueRefreshToken,
  rotateRefreshToken,
  requireMobileAuth,
  revokeAllRefreshTokens,
  signAccessToken,
  MobileJWTPayload,
} from "../lib/mobileAuth";
import { verifySocialToken, SocialProvider } from "../lib/socialAuth";
import { decryptSymmetric } from "../services/encrpytion";
import { hashRegistrationNumber } from "../lib/hash";

/**
 * Mobile API — mounted at /api/mobile in src/index.ts.
 *
 * Notes on the data model used here:
 *   - An "app user" is any user row that has a corresponding normal_user
 *     row. We ensure that row exists on signup / first social login so
 *     the role check is consistent.
 *   - "Children" are parent_child_link rows owned by the user.
 *   - "Hospital links" are child_hospital_link rows connecting a child
 *     profile to a real hospital patient record. Deleting a child only
 *     deletes the link rows — the hospital's patient + measurements stay.
 *   - Hospital linking verifies registration_number via the existing
 *     hash column and verifies date_of_birth by KMS-decrypting the
 *     stored ciphertext.
 */

const router = express.Router();

/* ------------------------------------------------------------------ *
 * Helpers                                                             *
 * ------------------------------------------------------------------ */

const REGULAR_ROLE = "regular_user" as const;

async function ensureNormalUser(userId: string): Promise<void> {
  await prisma.normal_user.upsert({
    where: { user_id: userId },
    update: {},
    create: { user_id: userId },
  });
}

type UserDTO = {
  id: string;
  username: string | null;
  email: string | null;
  role: "regular_user";
};

async function userDTO(userId: string): Promise<UserDTO | null> {
  const u = await prisma.user.findUnique({
    where: { id: userId },
    include: { password_auth: true },
  });
  if (u == null) return null;
  return {
    id: u.id,
    username: u.password_auth?.username ?? null,
    email: u.email,
    role: REGULAR_ROLE,
  };
}

async function issueAuthResponse(userId: string) {
  const { token, expiresIn } = signAccessToken({
    sub: userId,
    role: REGULAR_ROLE,
  });
  const refreshToken = await issueRefreshToken(userId);
  const user = await userDTO(userId);
  return {
    user,
    accessToken: token,
    refreshToken,
    accessTokenExpiresIn: expiresIn,
  };
}

function requireAppUser(req: express.Request): MobileJWTPayload {
  // Cast is safe: requireMobileAuth has already populated this.
  return req.mobileUser!;
}

/**
 * Discriminated union representing the two ways a child can be associated
 * with the requesting parent user:
 *
 *   - "app"  → a row in `parent_child_link` (created via the iOS app's
 *              "add child" flow). Has a nickname/DOB/sex and may be
 *              connected to multiple hospitals via child_hospital_link.
 *   - "web"  → a row in `user_patient` (created via the existing
 *              myopiamanage.org "register child" flow on the web). Has
 *              a single linked patient row (1 hospital).
 *
 * The `childId` is the unique identifier the iOS app exposes externally:
 *   - for app-source: parent_child_link.id
 *   - for web-source: patient.id
 * UUIDs are globally unique so no namespace collision is possible.
 */
type OwnedChild =
  | { source: "app"; childId: string; userId: string; appLink: { id: string; user_id: string; nickname: string; date_of_birth: Date; sex: SexEnum } }
  | { source: "web"; childId: string; userId: string; patientId: string };

/**
 * Resolves a childId for the requesting user, transparently looking in
 * both `parent_child_link` (app-source) and `user_patient` (web-source).
 * Returns null if no match was found or the child does not belong to
 * the user.
 */
async function findOwnedChild(
  childId: string,
  userId: string,
): Promise<OwnedChild | null> {
  // 1) App-source: parent_child_link
  const appLink = await prisma.parent_child_link.findUnique({
    where: { id: childId },
  });
  if (appLink != null && appLink.user_id === userId) {
    return { source: "app", childId: appLink.id, userId, appLink };
  }
  // 2) Web-source: user_patient (myopiamanage.org "register child")
  const userPatient = await prisma.user_patient.findUnique({
    where: { user_id_patient_id: { user_id: userId, patient_id: childId } },
  });
  if (userPatient != null) {
    return { source: "web", childId, userId, patientId: childId };
  }
  return null;
}

/** Compatibility shim — keep the old name working while we migrate
 *  call sites. Returns the underlying `parent_child_link` row for app
 *  sources and `null` for web sources. New code should use
 *  `findOwnedChild` directly.
 */
async function loadOwnedChild(userId: string, childId: string) {
  const owned = await findOwnedChild(childId, userId);
  if (owned == null) return null;
  if (owned.source !== "app") return null;
  return owned.appLink;
}
async function getOwnedChild(childId: string, userId: string) {
  return loadOwnedChild(userId, childId);
}

/**
 * Returns the patient ids for every hospital that a given child is
 * linked to, regardless of source.
 *
 *   - app-source children fan out across `child_hospital_link` rows
 *     (status: active).
 *   - web-source children resolve to the single linked patient (the
 *     1:1 mapping enforced by the web's user_patient flow).
 */
async function linkedPatientIds(childOrId: OwnedChild | string): Promise<
  { patientId: string; hospitalId: string; hospitalName: string }[]
> {
  // Backwards-compat: callers that passed a raw childId continue to
  // work as if it's an app-source child (which was the only case the
  // old signature supported).
  if (typeof childOrId === "string") {
    const links = await prisma.child_hospital_link.findMany({
      where: { parent_child_link_id: childOrId, status: "active" },
      include: { hospital: { select: { id: true, name: true } } },
    });
    return links.map((l) => ({
      patientId: l.patient_id,
      hospitalId: l.hospital_id,
      hospitalName: l.hospital.name,
    }));
  }

  if (childOrId.source === "web") {
    const patient = await prisma.patient.findUnique({
      where: { id: childOrId.patientId },
      include: { hospital: { select: { id: true, name: true } } },
    });
    if (patient == null) return [];
    return [
      {
        patientId: patient.id,
        hospitalId: patient.hospital_id,
        hospitalName: patient.hospital.name,
      },
    ];
  }

  // app-source
  const links = await prisma.child_hospital_link.findMany({
    where: { parent_child_link_id: childOrId.childId, status: "active" },
    include: { hospital: { select: { id: true, name: true } } },
  });
  return links.map((l) => ({
    patientId: l.patient_id,
    hospitalId: l.hospital_id,
    hospitalName: l.hospital.name,
  }));
}

/* ------------------------------------------------------------------ *
 * Auth                                                                *
 * ------------------------------------------------------------------ */

const signupSchema = zod.object({
  username: zod
    .string()
    .nonempty()
    .regex(/^[a-zA-Z0-9]+$/),
  password: zod.string().min(8),
  email: zod.string().email(),
  receive_email_updates: zod.boolean().optional(),
});

router.post(
  "/auth/signup",
  validateRequestBody(signupSchema),
  async (req, res) => {
    const data = req.body as zod.infer<typeof signupSchema>;
    const hash = await bcrypt.hash(data.password, 12);

    try {
      const user = await prisma.user.create({
        data: {
          email: data.email,
          receive_email_updates: data.receive_email_updates ?? false,
          password_auth: {
            create: {
              username: data.username,
              hash,
            },
          },
          normal_user: { create: {} },
        },
      });
      const body = await issueAuthResponse(user.id);
      res.status(201).json(body);
    } catch (e) {
      if (e instanceof PrismaClientKnownRequestError && e.code === "P2002") {
        res
          .status(400)
          .json({ error: "username already exists", code: "validation_error" });
        return;
      }
      throw e;
    }
  },
);

const loginSchema = zod.object({
  username: zod.string().nonempty(),
  password: zod.string().nonempty(),
});

router.post("/auth/login", validateRequestBody(loginSchema), async (req, res) => {
  const { username, password } = req.body as zod.infer<typeof loginSchema>;
  const auth = await prisma.password_auth.findUnique({
    where: { username },
    include: { user: true },
  });
  if (auth == null) {
    res.status(401).json({ error: "invalid credentials", code: "unauthorized" });
    return;
  }
  const ok = await bcrypt.compare(password, auth.hash);
  if (!ok) {
    res.status(401).json({ error: "invalid credentials", code: "unauthorized" });
    return;
  }
  await ensureNormalUser(auth.user.id);
  res.json(await issueAuthResponse(auth.user.id));
});

const socialSchema = zod.object({
  provider: zod.enum(["apple", "google", "kakao", "naver"]),
  token: zod.string().nonempty(),
  email: zod.string().email().optional(),
  receive_email_updates: zod.boolean().optional(),
});

router.post(
  "/auth/social",
  validateRequestBody(socialSchema),
  async (req, res) => {
    const body = req.body as zod.infer<typeof socialSchema>;
    let identity;
    try {
      identity = await verifySocialToken(
        body.provider as SocialProvider,
        body.token,
      );
    } catch (e) {
      res
        .status(401)
        .json({ error: "provider token rejected", code: "unauthorized" });
      return;
    }

    // Find-or-create user via oauth_identity(provider, subject).
    const existing = await prisma.oauth_identity.findUnique({
      where: {
        provider_subject: {
          provider: body.provider,
          subject: identity.subject,
        },
      },
    });

    let userId: string;
    if (existing) {
      userId = existing.user_id;
    } else {
      const created = await prisma.user.create({
        data: {
          email: identity.email ?? body.email ?? null,
          receive_email_updates: body.receive_email_updates ?? false,
          normal_user: { create: {} },
          oauth_identity: {
            create: {
              provider: body.provider,
              subject: identity.subject,
            },
          },
        },
      });
      userId = created.id;
    }
    await ensureNormalUser(userId);
    res.json(await issueAuthResponse(userId));
  },
);

const refreshSchema = zod.object({ refreshToken: zod.string().nonempty() });

router.post(
  "/auth/refresh",
  validateRequestBody(refreshSchema),
  async (req, res) => {
    const { refreshToken } = req.body as zod.infer<typeof refreshSchema>;
    try {
      const { userId, newRefreshToken } = await rotateRefreshToken(refreshToken);
      const { token, expiresIn } = signAccessToken({
        sub: userId,
        role: REGULAR_ROLE,
      });
      res.json({
        accessToken: token,
        refreshToken: newRefreshToken,
        accessTokenExpiresIn: expiresIn,
      });
    } catch {
      res.status(401).json({ error: "invalid refresh", code: "unauthorized" });
    }
  },
);

router.post("/auth/logout", requireMobileAuth, async (req, res) => {
  const user = requireAppUser(req);
  await revokeAllRefreshTokens(user.sub);
  res.json({ ok: true });
});

router.get("/auth/me", requireMobileAuth, async (req, res) => {
  const user = requireAppUser(req);
  const dto = await userDTO(user.sub);
  if (dto == null) {
    res.status(404).json({ error: "user not found", code: "not_found" });
    return;
  }
  res.json(dto);
});

/* ------------------------------------------------------------------ *
 * Children                                                            *
 * ------------------------------------------------------------------ */

function serializeDateOnly(d: Date): string {
  // YYYY-MM-DD, UTC-safe for DATE columns.
  return d.toISOString().slice(0, 10);
}

router.get("/children", requireMobileAuth, async (req, res) => {
  const user = requireAppUser(req);

  // ── App-source: parent_child_link rows the user owns ──────────────
  const appChildren = await prisma.parent_child_link.findMany({
    where: { user_id: user.sub },
    orderBy: { created_at: "asc" },
    include: {
      child_hospital_link: {
        include: {
          hospital: { select: { id: true, name: true, code: true } },
          patient: {
            select: {
              id: true,
              encrypted_registration_number: true,
            },
          },
        },
      },
    },
  });

  // ── Web-source: user_patient rows from myopiamanage.org ─────────────
  // We deliberately filter to user_patient ONLY (the regular_user
  // "register child" flow). HCP-managed patients without a user_patient
  // link never reach the iOS app, even if the patient row exists.
  const webChildren = await prisma.user_patient.findMany({
    where: { user_id: user.sub },
    include: {
      patient: {
        include: {
          hospital: { select: { id: true, name: true, code: true } },
        },
      },
    },
  });

  // Patient ids already represented by an app-source child — used to
  // dedupe so the same patient doesn't appear twice when a parent has
  // both an iOS parent_child_link and a web user_patient pointing at
  // the same patient row. App-source wins (richer metadata).
  const appPatientIds = new Set<string>(
    appChildren.flatMap((c) => c.child_hospital_link.map((l) => l.patient_id)),
  );

  const appResults = await Promise.all(
    appChildren.map(async (c) => ({
      childId: c.id,
      source: "app" as const,
      nickname: c.nickname,
      dateOfBirth: serializeDateOnly(c.date_of_birth),
      sex: c.sex,
      linkedHospitals: await Promise.all(
        c.child_hospital_link.map(async (l) => ({
          hospitalId: l.hospital.id,
          hospitalName: l.hospital.name,
          hospitalCode: l.hospital.code,
          patientId: l.patient_id,
          registrationNumber: await decryptSymmetric(
            l.patient.encrypted_registration_number,
          ),
          linkedAt: l.linked_at.toISOString(),
          status: l.status,
        })),
      ),
    })),
  );

  const webResults = await Promise.all(
    webChildren
      .filter((up) => !appPatientIds.has(up.patient_id))
      .map(async (up) => {
        const p = up.patient;
        const [regNumber, dob] = await Promise.all([
          decryptSymmetric(p.encrypted_registration_number),
          decryptSymmetric(p.encrypted_date_of_birth),
        ]);
        return {
          childId: p.id,                     // patient_id used as the public child id
          source: "web" as const,
          nickname: regNumber,               // web rows have no nickname; show MRN
          dateOfBirth: dob,                  // YYYY-MM-DD
          sex: p.sex,
          linkedHospitals: [
            {
              hospitalId: p.hospital.id,
              hospitalName: p.hospital.name,
              hospitalCode: p.hospital.code,
              patientId: p.id,
              registrationNumber: regNumber,
              linkedAt: p.created_at.toISOString(),
              status: "active" as const,
            },
          ],
        };
      }),
  );

  res.json([...appResults, ...webResults]);
});

const childCreateSchema = zod.object({
  nickname: zod.string().nonempty().max(80),
  dateOfBirth: zod.string().date(),
  sex: zod.nativeEnum(SexEnum),
});

router.post(
  "/children",
  requireMobileAuth,
  validateRequestBody(childCreateSchema),
  async (req, res) => {
    const user = requireAppUser(req);
    const data = req.body as zod.infer<typeof childCreateSchema>;
    const created = await prisma.parent_child_link.create({
      data: {
        user_id: user.sub,
        nickname: data.nickname,
        date_of_birth: new Date(data.dateOfBirth),
        sex: data.sex,
      },
    });
    res.status(201).json({
      childId: created.id,
      nickname: created.nickname,
      dateOfBirth: serializeDateOnly(created.date_of_birth),
      sex: created.sex,
      linkedHospitals: [],
    });
  },
);

const childPatchSchema = zod
  .object({
    nickname: zod.string().nonempty().max(80).optional(),
    dateOfBirth: zod.string().date().optional(),
    sex: zod.nativeEnum(SexEnum).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, {
    message: "at least one field is required",
  });

router.patch(
  "/children/:childId",
  requireMobileAuth,
  validateRequestBody(childPatchSchema),
  async (req, res) => {
    const user = requireAppUser(req);
    // Looking through findOwnedChild lets us distinguish the two
    // failure modes ("doesn't exist" vs "exists but is web-source so
    // not editable here").
    const owned = await findOwnedChild(String(req.params.childId), user.sub);
    if (owned == null) {
      res.status(404).json({ error: "child not found", code: "not_found" });
      return;
    }
    if (owned.source === "web") {
      res.status(400).json({
        error: "web-source children cannot be edited from the iOS app",
        code: "validation_error",
      });
      return;
    }
    const child = owned.appLink;
    const data = req.body as zod.infer<typeof childPatchSchema>;
    const updated = await prisma.parent_child_link.update({
      where: { id: child.id },
      data: {
        nickname: data.nickname,
        date_of_birth: data.dateOfBirth ? new Date(data.dateOfBirth) : undefined,
        sex: data.sex,
      },
    });
    res.json({
      childId: updated.id,
      nickname: updated.nickname,
      dateOfBirth: serializeDateOnly(updated.date_of_birth),
      sex: updated.sex,
    });
  },
);

/**
 * DELETE /children/:childId
 *
 * IMPORTANT: This NEVER touches the underlying patient record, its
 * measurements, or any HCP-managed clinical data. Behavior depends on
 * the source of the child:
 *
 *   - app-source: deletes the parent_child_link (and its
 *     child_hospital_link rows via cascade), and removes the matching
 *     user_patient mirror rows the iOS fan-out put there so the
 *     patient also disappears from myopiamanage.org's regular_user
 *     list. The patient row itself stays.
 *
 *   - web-source: only the user_patient row for this user+patient is
 *     removed (i.e. the same effect as the web "unlink child" button).
 *     The patient row stays.
 */
router.delete("/children/:childId", requireMobileAuth, async (req, res) => {
  const user = requireAppUser(req);
  const child = await findOwnedChild(String(req.params.childId), user.sub);
  if (child == null) {
    res.status(404).json({ error: "child not found", code: "not_found" });
    return;
  }

  if (child.source === "web") {
    await prisma.user_patient.deleteMany({
      where: { user_id: user.sub, patient_id: child.patientId },
    });
    res.json({ ok: true });
    return;
  }

  // app-source: collect linked patient_ids before cascade so we can
  // also clean up the user_patient mirrors.
  const links = await prisma.child_hospital_link.findMany({
    where: { parent_child_link_id: child.childId },
    select: { patient_id: true },
  });
  await prisma.$transaction(async (tx) => {
    await tx.parent_child_link.delete({ where: { id: child.childId } });
    if (links.length > 0) {
      await tx.user_patient.deleteMany({
        where: {
          user_id: user.sub,
          patient_id: { in: links.map((l) => l.patient_id) },
        },
      });
    }
  });
  res.json({ ok: true });
});

/* ------------------------------------------------------------------ *
 * Hospitals + hospital-links                                          *
 * ------------------------------------------------------------------ */

router.get("/hospitals", async (_req, res) => {
  const hospitals = await prisma.hospital.findMany({
    include: { country: { select: { code: true } } },
    orderBy: { name: "asc" },
  });
  res.json(
    hospitals.map((h) => ({
      hospitalId: h.id,
      name: h.name,
      code: h.code,
      country: h.country.code,
    })),
  );
});

const hospitalLinkSchema = zod.object({
  hospitalCode: zod.string().nonempty(),
  registrationNumber: zod.string().nonempty(),
});

router.post(
  "/children/:childId/hospital-links",
  requireMobileAuth,
  validateRequestBody(hospitalLinkSchema),
  async (req, res) => {
    const user = requireAppUser(req);
    const child = await loadOwnedChild(user.sub, String(req.params.childId));
    if (child == null) {
      res.status(404).json({ error: "child not found", code: "not_found" });
      return;
    }
    const body = req.body as zod.infer<typeof hospitalLinkSchema>;
    const hospital = await prisma.hospital.findUnique({
      where: { code: body.hospitalCode },
    });
    if (hospital == null) {
      res.status(404).json({ error: "no matching record", code: "not_found" });
      return;
    }

    // Find patient by (hospital_id, registration_number_hash).
    const regHash = hashRegistrationNumber(body.registrationNumber.trim());
    const patient = await prisma.patient.findUnique({
      where: {
        registration_number_hash_hospital_id: {
          registration_number_hash: regHash,
          hospital_id: hospital.id,
        },
      },
    });
    if (patient == null) {
      res.status(404).json({ error: "no matching record", code: "not_found" });
      return;
    }

    // Verify DOB + sex match what the parent entered for the child.
    const patientDOB = await decryptSymmetric(patient.encrypted_date_of_birth);
    const childDOB = serializeDateOnly(child.date_of_birth);
    if (patientDOB !== childDOB || patient.sex !== child.sex) {
      res.status(404).json({ error: "no matching record", code: "not_found" });
      return;
    }

    try {
      const link = await prisma.$transaction(async (tx) => {
        // 1) child_hospital_link — iOS-side mapping
        const created = await tx.child_hospital_link.create({
          data: {
            parent_child_link_id: child.id,
            hospital_id: hospital.id,
            patient_id: patient.id,
            status: "active",
          },
        });
        // 2) user_patient — mirror to the web-side mapping so the same
        //    patient also shows up on myopiamanage.org for this user.
        //    upsert handles the case where the user already has the
        //    patient registered on web (just leave the existing row).
        await tx.user_patient.upsert({
          where: {
            user_id_patient_id: {
              user_id: user.sub,
              patient_id: patient.id,
            },
          },
          create: { user_id: user.sub, patient_id: patient.id },
          update: {},
        });
        return created;
      });
      res.status(201).json({
        hospitalId: hospital.id,
        hospitalName: hospital.name,
        hospitalCode: hospital.code,
        registrationNumber: body.registrationNumber,
        linkedAt: link.linked_at.toISOString(),
        patientId: patient.id,
      });
    } catch (e) {
      if (e instanceof PrismaClientKnownRequestError && e.code === "P2002") {
        res.status(409).json({
          error: "child is already linked to this hospital",
          code: "validation_error",
        });
        return;
      }
      throw e;
    }
  },
);

router.delete(
  "/children/:childId/hospital-links/:hospitalId",
  requireMobileAuth,
  async (req, res) => {
    const user = requireAppUser(req);
    const child = await loadOwnedChild(user.sub, String(req.params.childId));
    if (child == null) {
      res.status(404).json({ error: "child not found", code: "not_found" });
      return;
    }
    try {
      await prisma.$transaction(async (tx) => {
        // 1) Find the link first so we know which patient_id it pointed at.
        const existing = await tx.child_hospital_link.findUnique({
          where: {
            parent_child_link_id_hospital_id: {
              parent_child_link_id: child.id,
              hospital_id: String(req.params.hospitalId),
            },
          },
        });
        if (existing == null) {
          throw new PrismaClientKnownRequestError("link not found", {
            code: "P2025",
            clientVersion: "n/a",
          });
        }

        // 2) Delete the iOS-side mapping.
        await tx.child_hospital_link.delete({ where: { id: existing.id } });

        // 3) If the user has no remaining child_hospital_link rows
        //    pointing at this patient, also drop the web-side
        //    user_patient mirror so the patient stops showing up in
        //    myopiamanage.org's regular_user list. This only fires if
        //    the user_patient row was originally created by the iOS
        //    fan-out (or if the user has effectively unlinked via the
        //    iOS UI). Web users who linked the patient on web first
        //    will still have their own user_patient row which we
        //    don't recreate when deleting the child_hospital_link, so
        //    the conservative read here is: cleanup is a no-op when
        //    the user_patient was set up before any iOS link existed.
        const stillLinked = await tx.child_hospital_link.findFirst({
          where: {
            patient_id: existing.patient_id,
            parent_child_link: { user_id: user.sub },
          },
        });
        if (stillLinked == null) {
          await tx.user_patient.deleteMany({
            where: { user_id: user.sub, patient_id: existing.patient_id },
          });
        }
      });
      res.json({ ok: true });
    } catch (e) {
      if (e instanceof PrismaClientKnownRequestError && e.code === "P2025") {
        res.status(404).json({ error: "link not found", code: "not_found" });
        return;
      }
      throw e;
    }
  },
);

/* ------------------------------------------------------------------ *
 * Measurements (read-only aggregations across linked hospitals)       *
 * ------------------------------------------------------------------ */

const dateRangeSchema = zod.object({
  from: zod.string().date().optional(),
  to: zod.string().date().optional(),
});

function parseDateRange(query: unknown) {
  const parsed = dateRangeSchema.safeParse(query);
  if (!parsed.success) return null;
  const { from, to } = parsed.data;
  return {
    from: from ? new Date(from) : undefined,
    to: to ? new Date(to) : undefined,
  };
}

async function guardChild(
  req: express.Request,
  res: express.Response,
): Promise<{
  child: OwnedChild;
  patients: Awaited<ReturnType<typeof linkedPatientIds>>;
} | null> {
  const user = requireAppUser(req);
  const child = await findOwnedChild(String(req.params.childId), user.sub);
  if (child == null) {
    res.status(404).json({ error: "child not found", code: "not_found" });
    return null;
  }
  const patients = await linkedPatientIds(child);
  return { child, patients };
}

router.get(
  "/children/:childId/axial-length",
  requireMobileAuth,
  async (req, res) => {
    const loaded = await guardChild(req, res);
    if (!loaded) return;
    const { patients } = loaded;
    if (patients.length === 0) {
      res.json([]);
      return;
    }
    const range = parseDateRange(req.query);
    if (range == null) {
      res
        .status(400)
        .json({ error: "invalid date range", code: "validation_error" });
      return;
    }

    const rows = await prisma.measurement.findMany({
      where: {
        patient_id: { in: patients.map((p) => p.patientId) },
        date: { gte: range.from, lte: range.to },
      },
      include: { instrument: { select: { name: true, id: true } } },
      orderBy: { date: "asc" },
    });

    const byPatient = new Map(patients.map((p) => [p.patientId, p]));
    res.json(
      rows.map((m) => {
        const meta = byPatient.get(m.patient_id)!;
        return {
          date: serializeDateOnly(m.date),
          od: m.od,
          os: m.os,
          instrumentId: m.instrument.id,
          instrumentName: m.instrument.name,
          hospitalId: meta.hospitalId,
          hospitalName: meta.hospitalName,
        };
      }),
    );
  },
);

router.get(
  "/children/:childId/refractive-error",
  requireMobileAuth,
  async (req, res) => {
    const loaded = await guardChild(req, res);
    if (!loaded) return;
    const { patients } = loaded;
    if (patients.length === 0) {
      res.json([]);
      return;
    }
    const range = parseDateRange(req.query);
    if (range == null) {
      res
        .status(400)
        .json({ error: "invalid date range", code: "validation_error" });
      return;
    }
    const rows = await prisma.refractive_error.findMany({
      where: {
        patient_id: { in: patients.map((p) => p.patientId) },
        date: { gte: range.from, lte: range.to },
      },
      include: { refractive_error_method: { select: { name: true } } },
      orderBy: { date: "asc" },
    });
    const byPatient = new Map(patients.map((p) => [p.patientId, p]));
    res.json(
      rows.map((r) => {
        const meta = byPatient.get(r.patient_id)!;
        return {
          date: serializeDateOnly(r.date),
          od_sph: r.od_sph,
          od_cyl: r.od_cyl,
          os_sph: r.os_sph,
          os_cyl: r.os_cyl,
          method: r.refractive_error_method.name,
          hospitalId: meta.hospitalId,
          hospitalName: meta.hospitalName,
        };
      }),
    );
  },
);

router.get(
  "/children/:childId/mean-k",
  requireMobileAuth,
  async (req, res) => {
    const loaded = await guardChild(req, res);
    if (!loaded) return;
    const { patients } = loaded;
    if (patients.length === 0) {
      res.json([]);
      return;
    }
    const rows = await prisma.patient_k.findMany({
      where: { patient_id: { in: patients.map((p) => p.patientId) } },
    });
    const byPatient = new Map(patients.map((p) => [p.patientId, p]));
    res.json(
      rows.map((k) => {
        const meta = byPatient.get(k.patient_id)!;
        return {
          kType: k.k_type,
          od: k.od,
          os: k.os,
          hospitalId: meta.hospitalId,
          hospitalName: meta.hospitalName,
        };
      }),
    );
  },
);

router.get(
  "/children/:childId/treatments",
  requireMobileAuth,
  async (req, res) => {
    const loaded = await guardChild(req, res);
    if (!loaded) return;
    const { patients } = loaded;
    if (patients.length === 0) {
      res.json([]);
      return;
    }
    const rows = await prisma.patient_treatment.findMany({
      where: { patient_id: { in: patients.map((p) => p.patientId) } },
      include: { treatment: { select: { name: true } } },
      orderBy: { start_date: "asc" },
    });
    const byPatient = new Map(patients.map((p) => [p.patientId, p]));
    res.json(
      rows.map((t) => {
        const meta = byPatient.get(t.patient_id)!;
        return {
          id: t.id,
          treatment: t.treatment.name,
          startDate: serializeDateOnly(t.start_date),
          endDate: t.end_date ? serializeDateOnly(t.end_date) : null,
          hospitalId: meta.hospitalId,
          hospitalName: meta.hospitalName,
        };
      }),
    );
  },
);

router.get(
  "/children/:childId/summary",
  requireMobileAuth,
  async (req, res) => {
    const loaded = await guardChild(req, res);
    if (!loaded) return;
    const { patients } = loaded;
    if (patients.length === 0) {
      res.json({
        latestAxial: null,
        latestRefractive: null,
        riskStatus: null,
        measurementCount: 0,
      });
      return;
    }
    const patientIds = patients.map((p) => p.patientId);
    const [latestAxial, latestRefractive, measurementCount] = await Promise.all([
      prisma.measurement.findFirst({
        where: { patient_id: { in: patientIds } },
        orderBy: { date: "desc" },
      }),
      prisma.refractive_error.findFirst({
        where: { patient_id: { in: patientIds } },
        orderBy: { date: "desc" },
      }),
      prisma.measurement.count({
        where: { patient_id: { in: patientIds } },
      }),
    ]);

    // Simple risk heuristic based on the latest axial length. The web app's
    // real risk model can replace this later without changing the contract.
    let riskStatus: "low" | "monitoring" | "moderate" | "high" | null = null;
    if (latestAxial) {
      const maxEye = Math.max(latestAxial.od ?? 0, latestAxial.os ?? 0);
      if (maxEye >= 26) riskStatus = "high";
      else if (maxEye >= 25) riskStatus = "moderate";
      else if (maxEye >= 24) riskStatus = "monitoring";
      else riskStatus = "low";
    }

    res.json({
      latestAxial: latestAxial
        ? {
            date: serializeDateOnly(latestAxial.date),
            od: latestAxial.od,
            os: latestAxial.os,
          }
        : null,
      latestRefractive: latestRefractive
        ? {
            date: serializeDateOnly(latestRefractive.date),
            od_sph: latestRefractive.od_sph,
            od_cyl: latestRefractive.od_cyl,
            os_sph: latestRefractive.os_sph,
            os_cyl: latestRefractive.os_cyl,
          }
        : null,
      riskStatus,
      measurementCount,
    });
  },
);

/* ------------------------------------------------------------------ *
 * Parent-entered data: parental refraction + lifestyle activity        *
 *                                                                      *
 * Writes are fanned out to every linked patient row so each hospital   *
 * sees the same value on the web side. Reads come from any one of the  *
 * linked patients (they're kept in sync, so we just pick the first).   *
 *                                                                      *
 * NOTE: parental_myopia rows are kept "current value only" — a PUT     *
 * deletes any existing rows for that patient+sex and inserts one new   *
 * row, since parental refraction doesn't change meaningfully over      *
 * time. Lifestyle activity rows are append-only timeline entries so    *
 * the web charts can show trend.                                       *
 * ------------------------------------------------------------------ */

const PARENT_SEX_VALUES = ["male", "female"] as const;
const MYOPIA_STATUS_VALUES = [
  "myopia",
  "high_myopia",
  "emmetropia",
  "hyperopia",
  "unknown",
] as const;

/** GET /api/mobile/children/:childId/parental-myopia
 * Returns the latest parental_myopia_status row for each parent_sex
 * across the linked patients. If multiple linked patients have rows we
 * trust them to be in sync (we always write through both); we report
 * the most recent timestamp.
 */
router.get(
  "/children/:childId/parental-myopia",
  requireMobileAuth,
  async (req, res) => {
    const userId = req.mobileUser!.sub;
    const child = await findOwnedChild(String(req.params.childId), userId);
    if (child == null) return res.status(404).json({ error: "child not found" });

    const links = await linkedPatientIds(child);
    if (links.length === 0) {
      return res.json({ mother: null, father: null });
    }

    const rows = await prisma.patient_parental_myopia_status.findMany({
      where: { patient_id: { in: links.map((l) => l.patientId) } },
      orderBy: { timestamp: "desc" },
    });

    function pick(parentSex: SexEnum) {
      const row = rows.find((r) => r.parent_sex === parentSex);
      return row
        ? { status: row.status, recordedAt: row.timestamp.toISOString() }
        : null;
    }

    res.json({
      mother: pick(SexEnum.female),
      father: pick(SexEnum.male),
    });
  },
);

/** PUT /api/mobile/children/:childId/parental-myopia
 *
 * Body: { mother?: { status: myopia_status } | null,
 *         father?: { status: myopia_status } | null }
 *
 * For each provided parent the server: (1) deletes existing rows for
 * (patient_id, parent_sex) on every linked patient; (2) inserts one new
 * row per linked patient. Pass `null` to clear ("Don't know" without
 * even storing 'unknown'); omit the key to leave that parent untouched.
 */
const parentalMyopiaUpdateSchema = zod.object({
  mother: zod
    .object({ status: zod.enum(MYOPIA_STATUS_VALUES) })
    .nullable()
    .optional(),
  father: zod
    .object({ status: zod.enum(MYOPIA_STATUS_VALUES) })
    .nullable()
    .optional(),
});

router.put(
  "/children/:childId/parental-myopia",
  requireMobileAuth,
  validateRequestBody(parentalMyopiaUpdateSchema),
  async (req, res) => {
    const userId = req.mobileUser!.sub;
    const child = await findOwnedChild(String(req.params.childId), userId);
    if (child == null) return res.status(404).json({ error: "child not found" });

    const links = await linkedPatientIds(child);
    if (links.length === 0) {
      return res
        .status(400)
        .json({ error: "child has no linked hospitals to write to" });
    }

    const body = req.body as zod.infer<typeof parentalMyopiaUpdateSchema>;

    const tasks: { sex: SexEnum; status: MyopiaStatusEnum | null }[] = [];
    if ("mother" in body) {
      tasks.push({
        sex: SexEnum.female,
        status: body.mother == null ? null : (body.mother.status as MyopiaStatusEnum),
      });
    }
    if ("father" in body) {
      tasks.push({
        sex: SexEnum.male,
        status: body.father == null ? null : (body.father.status as MyopiaStatusEnum),
      });
    }

    await prisma.$transaction(async (tx) => {
      for (const t of tasks) {
        // wipe existing rows for every linked patient + this parent_sex
        await tx.patient_parental_myopia_status.deleteMany({
          where: {
            patient_id: { in: links.map((l) => l.patientId) },
            parent_sex: t.sex,
          },
        });
        if (t.status == null) continue;
        // insert a fresh row on every linked patient
        await tx.patient_parental_myopia_status.createMany({
          data: links.map((l) => ({
            patient_id: l.patientId,
            parent_sex: t.sex,
            status: t.status as MyopiaStatusEnum,
          })),
        });
      }
    });

    res.json({ ok: true, hospitalsWritten: links.length });
  },
);

/** Lifestyle activity helpers
 *
 * Both nearwork and outdoor share the exact same shape — a tiny generic
 * keeps things terse while staying typesafe.
 */
type ActivityKind = "nearwork" | "outdoor";

const lifestyleEntrySchema = zod.object({
  hours: zod.number().int().min(0).max(24),
  recordedAt: zod.string().datetime().optional(),
});

async function listActivity(
  kind: ActivityKind,
  patientIds: string[],
): Promise<{ id: string; hours: number | null; recordedAt: string }[]> {
  const where = { patient_id: { in: patientIds } };
  const rows =
    kind === "nearwork"
      ? await prisma.patient_nearwork_activity.findMany({
          where,
          orderBy: { timestamp: "desc" },
        })
      : await prisma.patient_outdoor_activity.findMany({
          where,
          orderBy: { timestamp: "desc" },
        });
  // collapse duplicates from fan-out: same (timestamp, hours) across
  // hospitals counts as a single entry.
  const seen = new Set<string>();
  const out: { id: string; hours: number | null; recordedAt: string }[] = [];
  for (const r of rows) {
    const key = `${r.timestamp.toISOString()}|${r.hours ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      id: r.id,
      hours: r.hours,
      recordedAt: r.timestamp.toISOString(),
    });
  }
  return out;
}

async function createActivity(
  kind: ActivityKind,
  links: { patientId: string }[],
  hours: number,
  recordedAt: Date,
) {
  const data = links.map((l) => ({
    patient_id: l.patientId,
    hours,
    timestamp: recordedAt,
  }));
  if (kind === "nearwork") {
    await prisma.patient_nearwork_activity.createMany({ data });
  } else {
    await prisma.patient_outdoor_activity.createMany({ data });
  }
}

function makeActivityRoutes(kind: ActivityKind, urlSegment: string) {
  router.get(
    `/children/:childId/${urlSegment}`,
    requireMobileAuth,
    async (req, res) => {
      const userId = req.mobileUser!.sub;
      const child = await findOwnedChild(String(req.params.childId), userId);
      if (child == null) return res.status(404).json({ error: "child not found" });

      const links = await linkedPatientIds(child);
      if (links.length === 0) return res.json({ entries: [] });

      const entries = await listActivity(kind, links.map((l) => l.patientId));
      res.json({ entries });
    },
  );

  router.post(
    `/children/:childId/${urlSegment}`,
    requireMobileAuth,
    validateRequestBody(lifestyleEntrySchema),
    async (req, res) => {
      const userId = req.mobileUser!.sub;
      const child = await findOwnedChild(String(req.params.childId), userId);
      if (child == null) return res.status(404).json({ error: "child not found" });

      const links = await linkedPatientIds(child);
      if (links.length === 0) {
        return res
          .status(400)
          .json({ error: "child has no linked hospitals to write to" });
      }

      const body = req.body as zod.infer<typeof lifestyleEntrySchema>;
      const recordedAt = body.recordedAt ? new Date(body.recordedAt) : new Date();
      await createActivity(kind, links, body.hours, recordedAt);

      res.status(201).json({
        ok: true,
        hours: body.hours,
        recordedAt: recordedAt.toISOString(),
        hospitalsWritten: links.length,
      });
    },
  );
}

makeActivityRoutes("nearwork", "nearwork-activity");
makeActivityRoutes("outdoor", "outdoor-activity");

/** GET /api/mobile/children/:childId/lifestyle-reminder
 *
 * Returns a small summary used by the iOS reminder banner: the most
 * recent nearwork + outdoor entry timestamps, and a `dueForUpdate` flag
 * that the app uses to decide whether to nag the parent. The cadence is
 * 6 months — anything older than that triggers the banner.
 */
router.get(
  "/children/:childId/lifestyle-reminder",
  requireMobileAuth,
  async (req, res) => {
    const userId = req.mobileUser!.sub;
    const child = await findOwnedChild(String(req.params.childId), userId);
    if (child == null) return res.status(404).json({ error: "child not found" });

    const links = await linkedPatientIds(child);
    if (links.length === 0) {
      return res.json({
        dueForUpdate: false,
        nearwork: null,
        outdoor: null,
      });
    }
    const patientIds = links.map((l) => l.patientId);
    const [latestNearwork, latestOutdoor] = await Promise.all([
      prisma.patient_nearwork_activity.findFirst({
        where: { patient_id: { in: patientIds } },
        orderBy: { timestamp: "desc" },
      }),
      prisma.patient_outdoor_activity.findFirst({
        where: { patient_id: { in: patientIds } },
        orderBy: { timestamp: "desc" },
      }),
    ]);

    const SIX_MONTHS_MS = 1000 * 60 * 60 * 24 * 30 * 6;
    const now = Date.now();
    const isStale = (d: Date | null | undefined) =>
      d == null || now - d.getTime() > SIX_MONTHS_MS;

    res.json({
      dueForUpdate:
        isStale(latestNearwork?.timestamp) || isStale(latestOutdoor?.timestamp),
      nearwork: latestNearwork
        ? {
            hours: latestNearwork.hours,
            recordedAt: latestNearwork.timestamp.toISOString(),
          }
        : null,
      outdoor: latestOutdoor
        ? {
            hours: latestOutdoor.hours,
            recordedAt: latestOutdoor.timestamp.toISOString(),
          }
        : null,
    });
  },
);

/* ================================================================== *
 * Community board (자유게시판)                                         *
 *                                                                    *
 * Posts and comments are soft-deleted via the deleted_at column —    *
 * we never DELETE rows so reply chains remain navigable. The API     *
 * filters out deleted rows for everyone except the original author,  *
 * who instead sees a tombstoned placeholder body so they know the    *
 * delete actually took effect.                                       *
 *                                                                    *
 * Likes are idempotent on the DB side via composite primary keys —   *
 * POST /like twice is a no-op, DELETE /like is also idempotent.      *
 * ================================================================== */

const POST_LIST_PAGE_SIZE = 20;
const COMMENT_PAGE_SIZE = 200; // realistically a single post won't exceed this

type CommunityAuthorDTO = {
  id: string;
  username: string | null;
  isMe: boolean;
};

async function authorDTO(userId: string, viewerId: string): Promise<CommunityAuthorDTO> {
  const u = await prisma.user.findUnique({
    where: { id: userId },
    include: { password_auth: true },
  });
  return {
    id: userId,
    username: u?.password_auth?.username ?? null,
    isMe: userId === viewerId,
  };
}

/** GET /api/mobile/community/posts?cursor=<id>&pageSize=20
 *
 * Reverse-chronological feed. Pagination uses created_at + id as a
 * keyset cursor so it survives concurrent inserts without dupes/gaps.
 */
router.get("/community/posts", requireMobileAuth, async (req, res) => {
  const viewerId = req.mobileUser!.sub;
  const pageSize = Math.min(
    Number.parseInt(String(req.query.pageSize ?? POST_LIST_PAGE_SIZE), 10) ||
      POST_LIST_PAGE_SIZE,
    50,
  );
  const cursor = typeof req.query.cursor === "string" ? req.query.cursor : null;

  const cursorRow = cursor
    ? await prisma.community_post.findUnique({ where: { id: cursor } })
    : null;

  const rows = await prisma.community_post.findMany({
    where: {
      deleted_at: null,
      ...(cursorRow != null && {
        OR: [
          { created_at: { lt: cursorRow.created_at } },
          {
            created_at: cursorRow.created_at,
            id: { lt: cursorRow.id },
          },
        ],
      }),
    },
    orderBy: [{ created_at: "desc" }, { id: "desc" }],
    take: pageSize + 1, // fetch one extra to know if there's more
    include: {
      _count: { select: { comments: true, likes: true } },
      likes: { where: { user_id: viewerId }, take: 1 },
      user: { include: { password_auth: true } },
    },
  });

  const hasMore = rows.length > pageSize;
  const slice = rows.slice(0, pageSize);
  const nextCursor = hasMore ? slice[slice.length - 1].id : null;

  res.json({
    posts: slice.map((p) => ({
      id: p.id,
      title: p.title,
      bodyPreview: p.body.length > 200 ? p.body.slice(0, 200) + "…" : p.body,
      author: {
        id: p.user_id,
        username: p.user.password_auth?.username ?? null,
        isMe: p.user_id === viewerId,
      },
      createdAt: p.created_at.toISOString(),
      updatedAt: p.updated_at.toISOString(),
      commentCount: p._count.comments,
      likeCount: p._count.likes,
      likedByMe: p.likes.length > 0,
    })),
    nextCursor,
  });
});

const createPostSchema = zod.object({
  title: zod.string().trim().min(1).max(200),
  body: zod.string().trim().min(1).max(20_000),
});

/** POST /api/mobile/community/posts */
router.post(
  "/community/posts",
  requireMobileAuth,
  validateRequestBody(createPostSchema),
  async (req, res) => {
    const userId = req.mobileUser!.sub;
    const { title, body } = req.body as zod.infer<typeof createPostSchema>;
    const post = await prisma.community_post.create({
      data: { user_id: userId, title, body },
    });
    res.status(201).json({
      id: post.id,
      title: post.title,
      body: post.body,
      author: await authorDTO(userId, userId),
      createdAt: post.created_at.toISOString(),
      updatedAt: post.updated_at.toISOString(),
      commentCount: 0,
      likeCount: 0,
      likedByMe: false,
    });
  },
);

/** GET /api/mobile/community/posts/:id */
router.get("/community/posts/:id", requireMobileAuth, async (req, res) => {
  const viewerId = req.mobileUser!.sub;
  const post = await prisma.community_post.findUnique({
    where: { id: String(req.params.id) },
    include: {
      _count: { select: { comments: { where: { deleted_at: null } }, likes: true } },
      likes: { where: { user_id: viewerId }, take: 1 },
      user: { include: { password_auth: true } },
    },
  });
  if (post == null || post.deleted_at != null) {
    return res.status(404).json({ error: "post not found" });
  }
  res.json({
    id: post.id,
    title: post.title,
    body: post.body,
    author: {
      id: post.user_id,
      username: post.user.password_auth?.username ?? null,
      isMe: post.user_id === viewerId,
    },
    createdAt: post.created_at.toISOString(),
    updatedAt: post.updated_at.toISOString(),
    commentCount: post._count.comments,
    likeCount: post._count.likes,
    likedByMe: post.likes.length > 0,
  });
});

const updatePostSchema = zod.object({
  title: zod.string().trim().min(1).max(200).optional(),
  body: zod.string().trim().min(1).max(20_000).optional(),
});

/** PATCH /api/mobile/community/posts/:id — author only */
router.patch(
  "/community/posts/:id",
  requireMobileAuth,
  validateRequestBody(updatePostSchema),
  async (req, res) => {
    const userId = req.mobileUser!.sub;
    const post = await prisma.community_post.findUnique({
      where: { id: String(req.params.id) },
    });
    if (post == null || post.deleted_at != null) {
      return res.status(404).json({ error: "post not found" });
    }
    if (post.user_id !== userId) {
      return res.status(403).json({ error: "not your post" });
    }
    const data = req.body as zod.infer<typeof updatePostSchema>;
    if (data.title == null && data.body == null) {
      return res.status(400).json({ error: "nothing to update" });
    }
    const updated = await prisma.community_post.update({
      where: { id: post.id },
      data: { ...data },
    });
    res.json({
      id: updated.id,
      title: updated.title,
      body: updated.body,
      updatedAt: updated.updated_at.toISOString(),
    });
  },
);

/** DELETE /api/mobile/community/posts/:id — soft-delete; author only */
router.delete("/community/posts/:id", requireMobileAuth, async (req, res) => {
  const userId = req.mobileUser!.sub;
  const post = await prisma.community_post.findUnique({
    where: { id: String(req.params.id) },
  });
  if (post == null || post.deleted_at != null) {
    return res.status(404).json({ error: "post not found" });
  }
  if (post.user_id !== userId) {
    return res.status(403).json({ error: "not your post" });
  }
  await prisma.community_post.update({
    where: { id: post.id },
    data: { deleted_at: new Date() },
  });
  res.json({ ok: true });
});

/** GET /api/mobile/community/posts/:id/comments
 *
 * Returns a flat list of comments ordered by created_at ASC, with the
 * parent_comment_id set for replies. The client rebuilds the
 * top-level → replies tree (one level deep is enough for v1).
 *
 * Deleted comments are returned with body=null + deleted=true so the
 * UI can render a "(deleted)" placeholder rather than disappearing
 * mid-thread.
 */
router.get(
  "/community/posts/:id/comments",
  requireMobileAuth,
  async (req, res) => {
    const viewerId = req.mobileUser!.sub;
    const postExists = await prisma.community_post.findFirst({
      where: { id: String(req.params.id), deleted_at: null },
      select: { id: true },
    });
    if (postExists == null) return res.status(404).json({ error: "post not found" });

    const rows = await prisma.community_comment.findMany({
      where: { post_id: String(req.params.id) },
      orderBy: [{ created_at: "asc" }, { id: "asc" }],
      take: COMMENT_PAGE_SIZE,
      include: {
        _count: { select: { likes: true } },
        likes: { where: { user_id: viewerId }, take: 1 },
        user: { include: { password_auth: true } },
      },
    });

    res.json({
      comments: rows.map((c) => ({
        id: c.id,
        postId: c.post_id,
        parentCommentId: c.parent_comment_id,
        body: c.deleted_at != null ? null : c.body,
        deleted: c.deleted_at != null,
        author: {
          id: c.user_id,
          username: c.user.password_auth?.username ?? null,
          isMe: c.user_id === viewerId,
        },
        createdAt: c.created_at.toISOString(),
        updatedAt: c.updated_at.toISOString(),
        likeCount: c._count.likes,
        likedByMe: c.likes.length > 0,
      })),
    });
  },
);

const createCommentSchema = zod.object({
  body: zod.string().trim().min(1).max(5_000),
  parentCommentId: zod.string().uuid().nullable().optional(),
});

/** POST /api/mobile/community/posts/:id/comments
 *
 * `parentCommentId` is optional; pass it to make the comment a reply.
 * Replies-of-replies are flattened — if the supplied parent itself has
 * a parent, we use its parent's id instead so the tree never goes
 * deeper than one level.
 */
router.post(
  "/community/posts/:id/comments",
  requireMobileAuth,
  validateRequestBody(createCommentSchema),
  async (req, res) => {
    const userId = req.mobileUser!.sub;
    const postId = String(req.params.id);
    const post = await prisma.community_post.findFirst({
      where: { id: postId, deleted_at: null },
      select: { id: true },
    });
    if (post == null) return res.status(404).json({ error: "post not found" });

    const { body, parentCommentId } = req.body as zod.infer<
      typeof createCommentSchema
    >;

    let resolvedParentId: string | null = null;
    if (parentCommentId != null) {
      const parent = await prisma.community_comment.findUnique({
        where: { id: parentCommentId },
      });
      if (parent == null || parent.post_id !== postId || parent.deleted_at != null) {
        return res.status(400).json({ error: "invalid parentCommentId" });
      }
      // Flatten one level: a reply to a reply attaches to the top-level comment.
      resolvedParentId = parent.parent_comment_id ?? parent.id;
    }

    const comment = await prisma.community_comment.create({
      data: {
        post_id: postId,
        user_id: userId,
        parent_comment_id: resolvedParentId,
        body,
      },
    });

    res.status(201).json({
      id: comment.id,
      postId: comment.post_id,
      parentCommentId: comment.parent_comment_id,
      body: comment.body,
      deleted: false,
      author: await authorDTO(userId, userId),
      createdAt: comment.created_at.toISOString(),
      updatedAt: comment.updated_at.toISOString(),
      likeCount: 0,
      likedByMe: false,
    });
  },
);

/** DELETE /api/mobile/community/comments/:id — soft-delete; author only */
router.delete(
  "/community/comments/:id",
  requireMobileAuth,
  async (req, res) => {
    const userId = req.mobileUser!.sub;
    const comment = await prisma.community_comment.findUnique({
      where: { id: String(req.params.id) },
    });
    if (comment == null || comment.deleted_at != null) {
      return res.status(404).json({ error: "comment not found" });
    }
    if (comment.user_id !== userId) {
      return res.status(403).json({ error: "not your comment" });
    }
    await prisma.community_comment.update({
      where: { id: comment.id },
      data: { deleted_at: new Date() },
    });
    res.json({ ok: true });
  },
);

/** POST /api/mobile/community/posts/:id/like — idempotent */
router.post("/community/posts/:id/like", requireMobileAuth, async (req, res) => {
  const userId = req.mobileUser!.sub;
  const post = await prisma.community_post.findFirst({
    where: { id: String(req.params.id), deleted_at: null },
    select: { id: true },
  });
  if (post == null) return res.status(404).json({ error: "post not found" });
  try {
    await prisma.community_post_like.create({
      data: { post_id: post.id, user_id: userId },
    });
  } catch (e) {
    if (e instanceof PrismaClientKnownRequestError && e.code === "P2002") {
      /* already liked — fall through */
    } else {
      throw e;
    }
  }
  const likeCount = await prisma.community_post_like.count({
    where: { post_id: post.id },
  });
  res.json({ liked: true, likeCount });
});

/** DELETE /api/mobile/community/posts/:id/like — idempotent */
router.delete(
  "/community/posts/:id/like",
  requireMobileAuth,
  async (req, res) => {
    const userId = req.mobileUser!.sub;
    await prisma.community_post_like.deleteMany({
      where: { post_id: String(req.params.id), user_id: userId },
    });
    const likeCount = await prisma.community_post_like.count({
      where: { post_id: String(req.params.id) },
    });
    res.json({ liked: false, likeCount });
  },
);

/** POST /api/mobile/community/comments/:id/like — idempotent */
router.post(
  "/community/comments/:id/like",
  requireMobileAuth,
  async (req, res) => {
    const userId = req.mobileUser!.sub;
    const comment = await prisma.community_comment.findFirst({
      where: { id: String(req.params.id), deleted_at: null },
      select: { id: true },
    });
    if (comment == null)
      return res.status(404).json({ error: "comment not found" });
    try {
      await prisma.community_comment_like.create({
        data: { comment_id: comment.id, user_id: userId },
      });
    } catch (e) {
      if (e instanceof PrismaClientKnownRequestError && e.code === "P2002") {
        /* already liked — fall through */
      } else {
        throw e;
      }
    }
    const likeCount = await prisma.community_comment_like.count({
      where: { comment_id: comment.id },
    });
    res.json({ liked: true, likeCount });
  },
);

/** DELETE /api/mobile/community/comments/:id/like — idempotent */
router.delete(
  "/community/comments/:id/like",
  requireMobileAuth,
  async (req, res) => {
    const userId = req.mobileUser!.sub;
    await prisma.community_comment_like.deleteMany({
      where: { comment_id: String(req.params.id), user_id: userId },
    });
    const likeCount = await prisma.community_comment_like.count({
      where: { comment_id: String(req.params.id) },
    });
    res.json({ liked: false, likeCount });
  },
);

export default router;
