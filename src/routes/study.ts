import express from "express";
import zod from "zod";
import { Prisma } from "@prisma/client";
import prisma from "../lib/prisma";
import {
  approvedProfessionalRequired,
  siteAdminRequired,
  validateRequestBody,
} from "../lib/middlewares";
import { isPatientInHospital } from "../lib/authorization";
import {
  auditContextFromRequest,
  writeAuditFailure,
  writeAuditLog,
} from "../services/audit";

const router = express.Router();

/**
 * Audit context for site-admin routes. `siteAdminRequired` doesn't populate
 * req.healthcare_professional, so resolve the actor's name/role from the DB
 * (falling back to the user's email) so study logs carry the same actor detail
 * as the rest of the audit trail.
 */
async function adminAuditContext(req: express.Request) {
  const base = auditContextFromRequest(req);
  const userId = req.authSession?.user_id;
  if (!userId) return base;
  const hp = await prisma.healthcare_professional.findUnique({
    where: { user_id: userId },
    select: { name: true, role: true, hospital_id: true },
  });
  if (hp) {
    return {
      ...base,
      actorName: hp.name,
      actorRole: hp.role,
      actorHospitalId: hp.hospital_id,
    };
  }
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true },
  });
  return { ...base, actorName: user?.email ?? null, actorRole: "site_admin" };
}

/* --------------------------------------------------------------------------
 * Site-admin: study master list + per-study hospital assignment
 * ------------------------------------------------------------------------ */

const studyBodySchema = zod.object({
  name: zod.string().trim().min(1).max(200),
  // Required: the code drives the subject-number prefix ({code}-{hospital}-NNN),
  // so an empty code makes different studies produce indistinguishable numbers.
  code: zod.string().trim().min(1).max(50),
  description: zod.string().trim().optional(),
});

// GET /study/admin — all studies with participating-hospital counts.
// Not audit-logged: this list is polled by the admin UI (refetch on focus),
// so logging it floods the trail with meaningless site_admin READ rows. The
// meaningful "열람" — a professional viewing a patient's study data — is logged
// on GET /study/enrollment/:id instead.
router.get("/admin", siteAdminRequired, async (_req, res) => {
  const studies = await prisma.study.findMany({
    orderBy: { created_at: "asc" },
    include: { _count: { select: { study_hospital: true } } },
  });
  res.json(studies);
});

// POST /study/admin — create a study.
router.post(
  "/admin",
  siteAdminRequired,
  validateRequestBody(studyBodySchema),
  async (req, res) => {
    const data = req.body as zod.infer<typeof studyBodySchema>;
    try {
      const created = await prisma.study.create({ data });
      await writeAuditLog({
        ...(await adminAuditContext(req)),
        tableName: "study",
        recordId: created.id,
        action: "CREATE",
        newValue: created,
      });
      res.status(201).json(created);
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        res.status(409).json({ message: "study name already exists" });
        return;
      }
      throw error;
    }
  },
);

const studyPatchSchema = studyBodySchema.partial().extend({
  active: zod.boolean().optional(),
});

// PATCH /study/admin/:studyId — update a study (rename / toggle active / etc).
router.patch(
  "/admin/:studyId",
  siteAdminRequired,
  validateRequestBody(studyPatchSchema),
  async (req, res) => {
    const data = req.body as zod.infer<typeof studyPatchSchema>;
    const studyId = String(req.params.studyId);
    try {
      const oldValue = await prisma.study.findUnique({ where: { id: studyId } });
      const updated = await prisma.study.update({
        where: { id: studyId },
        data,
      });
      await writeAuditLog({
        ...(await adminAuditContext(req)),
        tableName: "study",
        recordId: updated.id,
        action: "UPDATE",
        oldValue,
        newValue: updated,
      });
      res.json(updated);
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2025"
      ) {
        res.sendStatus(404);
        return;
      }
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        res.status(409).json({ message: "study name already exists" });
        return;
      }
      throw error;
    }
  },
);

// DELETE /study/admin/:studyId — delete a study (cascades to its hospital
// assignments, enrolments and visits).
router.delete("/admin/:studyId", siteAdminRequired, async (req, res) => {
  const studyId = String(req.params.studyId);
  const ctx = await adminAuditContext(req);
  try {
    const deleted = await prisma.study.delete({ where: { id: studyId } });
    await writeAuditLog({
      ...ctx,
      tableName: "study",
      recordId: studyId,
      action: "DELETE",
      oldValue: deleted,
    });
    res.sendStatus(204);
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2025"
    ) {
      res.sendStatus(404);
      return;
    }
    await writeAuditFailure(
      { ...ctx, tableName: "study", recordId: studyId, action: "DELETE" },
      error,
    );
    throw error;
  }
});

// GET /study/admin/:studyId/hospital — hospital ids assigned to this study.
// Not audit-logged (config lookup, polled by the admin UI).
router.get("/admin/:studyId/hospital", siteAdminRequired, async (req, res) => {
  const studyId = String(req.params.studyId);
  const rows = await prisma.study_hospital.findMany({
    where: { study_id: studyId },
    select: { hospital_id: true },
  });
  res.json(rows.map((r) => r.hospital_id));
});

const assignHospitalSchema = zod.object({
  hospital_ids: zod.array(zod.string().uuid()),
});

// PUT /study/admin/:studyId/hospital — replace the set of participating
// hospitals for a study with the provided list.
router.put(
  "/admin/:studyId/hospital",
  siteAdminRequired,
  validateRequestBody(assignHospitalSchema),
  async (req, res) => {
    const studyId = String(req.params.studyId);
    const { hospital_ids } = req.body as zod.infer<typeof assignHospitalSchema>;

    const study = await prisma.study.findUnique({ where: { id: studyId } });
    if (!study) {
      res.sendStatus(404);
      return;
    }

    const oldRows = await prisma.study_hospital.findMany({
      where: { study_id: studyId },
      select: { hospital_id: true },
    });

    await prisma.$transaction([
      prisma.study_hospital.deleteMany({ where: { study_id: studyId } }),
      prisma.study_hospital.createMany({
        data: hospital_ids.map((hospital_id) => ({
          study_id: studyId,
          hospital_id,
        })),
        skipDuplicates: true,
      }),
    ]);
    await writeAuditLog({
      ...(await adminAuditContext(req)),
      tableName: "study_hospital",
      recordId: studyId,
      action: "UPDATE",
      oldValue: { hospital_ids: oldRows.map((r) => r.hospital_id) },
      newValue: { hospital_ids },
    });
    res.sendStatus(204);
  },
);

/* --------------------------------------------------------------------------
 * Professional: available studies, enrollment, visits
 * ------------------------------------------------------------------------ */

// GET /study/available — active studies the caller's hospital participates in.
router.get("/available", approvedProfessionalRequired, async (req, res) => {
  const hospitalId = req.healthcare_professional!.hospital_id;
  const studies = await prisma.study.findMany({
    where: {
      active: true,
      study_hospital: { some: { hospital_id: hospitalId } },
    },
    orderBy: { name: "asc" },
    select: { id: true, name: true, code: true, description: true },
  });
  res.json(studies);
});

// GET /study/enrollment?patient_id= — a patient's enrollments (drives which
// study buttons are shown/active on the chart page).
router.get("/enrollment", approvedProfessionalRequired, async (req, res) => {
  const patientId = String(req.query.patient_id ?? "");
  if (!patientId) {
    res.status(400).json({ message: "patient_id required" });
    return;
  }
  const hospitalId = req.healthcare_professional!.hospital_id;
  if (!(await isPatientInHospital(patientId, hospitalId))) {
    res.sendStatus(403);
    return;
  }
  const enrollments = await prisma.study_enrollment.findMany({
    where: { patient_id: patientId },
    include: { study: { select: { id: true, name: true, code: true } } },
    orderBy: { enrolled_at: "asc" },
  });
  res.json(enrollments);
});

const enrollSchema = zod.object({
  study_id: zod.string().uuid(),
  patient_id: zod.string().uuid(),
});

/** Whether a P2002 is a subject-number collision (vs. already-enrolled). */
function isSubjectNumberConflict(
  e: Prisma.PrismaClientKnownRequestError,
): boolean {
  const target = e.meta?.target;
  const s = Array.isArray(target) ? target.join(",") : String(target ?? "");
  return s.includes("subject");
}

/**
 * Creates an enrollment with an auto-assigned de-identified subject number
 * ({studyCode}-{hospitalCode}-{seq}), numbered per (study, hospital) so alert
 * emails can reference a patient without any real identifier. The sequence comes
 * from a count outside the unique constraint, so a concurrent enrollment can
 * collide — recompute and retry a few times before giving up.
 */
async function enrollWithSubjectNumber(params: {
  study_id: string;
  patient_id: string;
  enrolled_by: string;
  hospitalId: string;
  studyCode: string | null;
  hospitalCode: string;
}) {
  const codePart = (params.studyCode || "S").toUpperCase().replace(/\s+/g, "");
  const sitePart = params.hospitalCode.toUpperCase().replace(/\s+/g, "");
  const prefix = `${codePart}-${sitePart}-`;
  for (let attempt = 0; attempt < 5; attempt++) {
    // Take the max existing sequence for this (study, hospital), not the row
    // count: a deleted enrollment leaves a gap, and counting would re-issue an
    // already-used number and collide forever. subject_number is zero-padded so
    // a descending string sort yields the highest sequence.
    const latest = await prisma.study_enrollment.findFirst({
      where: {
        study_id: params.study_id,
        patient: { hospital_id: params.hospitalId },
        subject_number: { startsWith: prefix },
      },
      orderBy: { subject_number: "desc" },
      select: { subject_number: true },
    });
    let nextSeq = 1;
    if (latest?.subject_number) {
      const parsed = parseInt(latest.subject_number.split("-").pop() ?? "", 10);
      if (!Number.isNaN(parsed)) nextSeq = parsed + 1;
    }
    const subject_number = `${prefix}${String(nextSeq).padStart(3, "0")}`;
    try {
      return await prisma.study_enrollment.create({
        data: {
          study_id: params.study_id,
          patient_id: params.patient_id,
          enrolled_by: params.enrolled_by,
          subject_number,
        },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002" &&
        isSubjectNumberConflict(error)
      ) {
        continue; // subject-number race — recompute the sequence and retry
      }
      throw error;
    }
  }
  throw new Error("failed to assign subject number after retries");
}

// POST /study/enrollment — enroll a patient into a study.
router.post(
  "/enrollment",
  approvedProfessionalRequired,
  validateRequestBody(enrollSchema),
  async (req, res) => {
    const { study_id, patient_id } = req.body as zod.infer<typeof enrollSchema>;
    const hospitalId = req.healthcare_professional!.hospital_id;

    if (!(await isPatientInHospital(patient_id, hospitalId))) {
      res.sendStatus(403);
      return;
    }
    // The patient's hospital must be assigned to this (active) study.
    const allowed = await prisma.study.findFirst({
      where: {
        id: study_id,
        active: true,
        study_hospital: { some: { hospital_id: hospitalId } },
      },
      select: { id: true, code: true },
    });
    if (!allowed) {
      res.status(403).json({ message: "hospital not permitted for this study" });
      return;
    }
    const hospital = await prisma.hospital.findUnique({
      where: { id: hospitalId },
      select: { code: true },
    });

    const ctx = auditContextFromRequest(req);
    try {
      const created = await enrollWithSubjectNumber({
        study_id,
        patient_id,
        enrolled_by: req.authSession!.user_id,
        hospitalId,
        studyCode: allowed.code,
        hospitalCode: hospital?.code ?? "H",
      });
      await writeAuditLog({
        ...ctx,
        tableName: "study_enrollment",
        recordId: created.id,
        action: "CREATE",
        hospitalId,
        patientId: patient_id,
        newValue: created,
      });
      res.status(201).json(created);
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        res.status(409).json({ message: "patient already enrolled" });
        return;
      }
      await writeAuditFailure(
        {
          ...ctx,
          tableName: "study_enrollment",
          action: "CREATE",
          hospitalId,
          patientId: patient_id,
          newValue: { study_id, patient_id },
        },
        error,
      );
      throw error;
    }
  },
);

/** Whether a measurement exists and belongs to the given patient. */
async function measurementBelongsToPatient(
  measurementId: string,
  patientId: string,
): Promise<boolean> {
  const m = await prisma.measurement.findUnique({
    where: { id: measurementId },
    select: { patient_id: true },
  });
  return m != null && m.patient_id === patientId;
}

/** Resolve an enrollment and confirm the caller's hospital owns the patient. */
async function authorizeEnrollment(enrollmentId: string, hospitalId: string) {
  const enrollment = await prisma.study_enrollment.findUnique({
    where: { id: enrollmentId },
    include: {
      study: { select: { id: true, name: true, code: true } },
      patient: { select: { id: true, hospital_id: true } },
    },
  });
  if (!enrollment || enrollment.patient.hospital_id !== hospitalId) return null;
  return enrollment;
}

// GET /study/enrollment/:enrollmentId — enrollment header + its visits.
router.get(
  "/enrollment/:enrollmentId",
  approvedProfessionalRequired,
  async (req, res) => {
    const hospitalId = req.healthcare_professional!.hospital_id;
    const enrollment = await authorizeEnrollment(
      String(req.params.enrollmentId),
      hospitalId,
    );
    if (!enrollment) {
      res.sendStatus(404);
      return;
    }
    const visits = await prisma.study_visit.findMany({
      where: { enrollment_id: enrollment.id },
      orderBy: { visit_date: "desc" },
    });
    // 열람(READ) log: a professional accessed this patient's study data. This
    // is the compliance-relevant view (unlike the admin config lists), and the
    // client caches it (staleTime) so a refetch on focus doesn't re-log.
    writeAuditLog({
      ...auditContextFromRequest(req),
      tableName: "study_enrollment",
      recordId: enrollment.id,
      action: "READ",
      hospitalId,
      patientId: enrollment.patient.id,
    }).catch(console.error);
    res.json({
      id: enrollment.id,
      study: enrollment.study,
      patient_id: enrollment.patient.id,
      enrolled_at: enrollment.enrolled_at,
      visits,
    });
  },
);

// A numeric field that may be left blank (→ null → rendered as "N.D.").
const optionalNum = (min: number, max: number) =>
  zod.number().gte(min).lte(max).nullish();

const visitSchema = zod.object({
  visit_date: zod.string().date(),
  // 1) Snellen VA & 2) BCVA (0.0–1.5)
  va_od: optionalNum(0, 1.5),
  va_os: optionalNum(0, 1.5),
  bcva_od: optionalNum(0, 1.5),
  bcva_os: optionalNum(0, 1.5),
  // 3) Refraction (Auto/MR/CR) + sph/cyl/axis
  refraction_method: zod.enum(["Auto", "MR", "CR"]).nullish(),
  ref_od_sph: optionalNum(-30, 30),
  ref_od_cyl: optionalNum(-30, 30),
  ref_od_axis: zod.number().int().gte(0).lte(180).nullish(),
  ref_os_sph: optionalNum(-30, 30),
  ref_os_cyl: optionalNum(-30, 30),
  ref_os_axis: zod.number().int().gte(0).lte(180).nullish(),
  // 4) Slit lamp
  slitlamp_od_normal: zod.boolean().nullish(),
  slitlamp_od_finding: zod.string().nullish(),
  slitlamp_os_normal: zod.boolean().nullish(),
  slitlamp_os_finding: zod.string().nullish(),
  // 5) IOP (0.0–50.0) & 6) Accommodation (0.0–20.0)
  iop_od: optionalNum(0, 50),
  iop_os: optionalNum(0, 50),
  accom_od: optionalNum(0, 20),
  accom_os: optionalNum(0, 20),
  // 7) Axial length — write-back into the shared `measurement` table.
  //    Either link/update today's existing measurement, or create one.
  axial_length: zod
    .object({
      measurement_id: zod.string().uuid().nullish(),
      instrument_id: zod.string().uuid().nullish(),
      od: optionalNum(15, 40),
      os: optionalNum(15, 40),
    })
    .nullish(),
  // NOTE: "an AL value needs a measurement_id or instrument_id target" is
  // validated per-handler (POST vs PATCH), not here — PATCH may rely on the
  // visit's existing measurement, which this shared schema can't see.
  // 8) Concomitant meds & 9) Adverse event
  concomitant_meds: zod.string().nullish(),
  adverse_event: zod.string().nullish(),
});

// POST /study/enrollment/:enrollmentId/visit — record a study visit.
router.post(
  "/enrollment/:enrollmentId/visit",
  approvedProfessionalRequired,
  validateRequestBody(visitSchema),
  async (req, res) => {
    const hospitalId = req.healthcare_professional!.hospital_id;
    const enrollment = await authorizeEnrollment(
      String(req.params.enrollmentId),
      hospitalId,
    );
    if (!enrollment) {
      res.sendStatus(404);
      return;
    }
    const data = req.body as zod.infer<typeof visitSchema>;
    const { axial_length, ...visitFields } = data;
    const patientId = enrollment.patient.id;
    const userId = req.authSession!.user_id;
    const ctx = auditContextFromRequest(req);

    // Guard against IDOR: a client-supplied measurement_id must belong to this
    // patient, otherwise another patient's axial length could be overwritten.
    if (
      axial_length?.measurement_id &&
      !(await measurementBelongsToPatient(axial_length.measurement_id, patientId))
    ) {
      // 403 (not 400/404) to match the codebase's authz-failure convention and
      // avoid disclosing whether the measurement id exists.
      res.sendStatus(403);
      return;
    }

    // An entered AL value needs a target: an existing measurement to update or
    // an instrument to create a new one. Reject rather than silently drop it.
    if (
      axial_length &&
      (axial_length.od != null || axial_length.os != null) &&
      !axial_length.measurement_id &&
      !axial_length.instrument_id
    ) {
      res.status(400).json({
        message: "instrument_id is required to record axial length",
      });
      return;
    }

    try {
      const created = await prisma.$transaction(async (tx) => {
        // 7) Axial length write-back: upsert a measurement so it also shows on
        //    the main growth chart, then link it to the visit.
        let measurementId: string | null = axial_length?.measurement_id ?? null;
        if (axial_length && (axial_length.od != null || axial_length.os != null)) {
          if (measurementId) {
            await tx.measurement.update({
              where: { id: measurementId },
              data: { od: axial_length.od, os: axial_length.os },
            });
          } else if (axial_length.instrument_id) {
            const m = await tx.measurement.create({
              data: {
                patient_id: patientId,
                date: new Date(visitFields.visit_date),
                instrument_id: axial_length.instrument_id,
                od: axial_length.od ?? null,
                os: axial_length.os ?? null,
                creator_id: userId,
              },
            });
            measurementId = m.id;
          }
        }

        const visit = await tx.study_visit.create({
          data: {
            enrollment_id: enrollment.id,
            visit_date: new Date(visitFields.visit_date),
            created_by: userId,
            va_od: visitFields.va_od ?? null,
            va_os: visitFields.va_os ?? null,
            bcva_od: visitFields.bcva_od ?? null,
            bcva_os: visitFields.bcva_os ?? null,
            refraction_method: visitFields.refraction_method ?? null,
            ref_od_sph: visitFields.ref_od_sph ?? null,
            ref_od_cyl: visitFields.ref_od_cyl ?? null,
            ref_od_axis: visitFields.ref_od_axis ?? null,
            ref_os_sph: visitFields.ref_os_sph ?? null,
            ref_os_cyl: visitFields.ref_os_cyl ?? null,
            ref_os_axis: visitFields.ref_os_axis ?? null,
            slitlamp_od_normal: visitFields.slitlamp_od_normal ?? null,
            slitlamp_od_finding: visitFields.slitlamp_od_finding ?? null,
            slitlamp_os_normal: visitFields.slitlamp_os_normal ?? null,
            slitlamp_os_finding: visitFields.slitlamp_os_finding ?? null,
            iop_od: visitFields.iop_od ?? null,
            iop_os: visitFields.iop_os ?? null,
            accom_od: visitFields.accom_od ?? null,
            accom_os: visitFields.accom_os ?? null,
            measurement_id: measurementId,
            concomitant_meds: visitFields.concomitant_meds ?? null,
            adverse_event: visitFields.adverse_event ?? null,
          },
        });

        await writeAuditLog({
          ...ctx,
          tableName: "study_visit",
          recordId: visit.id,
          action: "CREATE",
          hospitalId,
          patientId,
          newValue: visit,
          client: tx,
        });
        return visit;
      });

      res.status(201).json(created);
    } catch (error) {
      await writeAuditFailure(
        {
          ...ctx,
          tableName: "study_visit",
          action: "CREATE",
          hospitalId,
          patientId,
          newValue: data,
        },
        error,
      );
      throw error;
    }
  },
);

// PATCH /study/enrollment/:enrollmentId/visit/:visitId — edit an existing visit.
router.patch(
  "/enrollment/:enrollmentId/visit/:visitId",
  approvedProfessionalRequired,
  validateRequestBody(visitSchema),
  async (req, res) => {
    const hospitalId = req.healthcare_professional!.hospital_id;
    const enrollment = await authorizeEnrollment(
      String(req.params.enrollmentId),
      hospitalId,
    );
    if (!enrollment) {
      res.sendStatus(404);
      return;
    }
    const visitId = String(req.params.visitId);
    const existing = await prisma.study_visit.findFirst({
      where: { id: visitId, enrollment_id: enrollment.id },
    });
    if (!existing) {
      res.sendStatus(404);
      return;
    }

    const data = req.body as zod.infer<typeof visitSchema>;
    const { axial_length, ...visitFields } = data;
    const patientId = enrollment.patient.id;
    const userId = req.authSession!.user_id;
    const ctx = auditContextFromRequest(req);

    // Guard against IDOR (see POST): a client-supplied measurement_id must
    // belong to this patient.
    if (
      axial_length?.measurement_id &&
      !(await measurementBelongsToPatient(axial_length.measurement_id, patientId))
    ) {
      // 403 (not 400/404) to match the codebase's authz-failure convention and
      // avoid disclosing whether the measurement id exists.
      res.sendStatus(403);
      return;
    }

    // An entered AL value needs a target. Unlike POST, an existing linked
    // measurement counts (the client may send just od/os to update it).
    if (
      axial_length &&
      (axial_length.od != null || axial_length.os != null) &&
      !axial_length.measurement_id &&
      !existing.measurement_id &&
      !axial_length.instrument_id
    ) {
      res.status(400).json({
        message: "instrument_id is required to record axial length",
      });
      return;
    }

    try {
      const updated = await prisma.$transaction(async (tx) => {
        // Resolve which measurement this visit links to. Distinguish an omitted
        // field (undefined → keep the existing link) from an explicit null
        // (unlink); a plain `??` chain would make unlinking impossible.
        let measurementId: string | null = existing.measurement_id;
        if (axial_length === null) {
          measurementId = null;
        } else if (
          axial_length !== undefined &&
          axial_length.measurement_id !== undefined
        ) {
          measurementId = axial_length.measurement_id;
        }
        if (
          axial_length &&
          (axial_length.od != null || axial_length.os != null)
        ) {
          if (measurementId) {
            await tx.measurement.update({
              where: { id: measurementId },
              data: { od: axial_length.od, os: axial_length.os },
            });
          } else if (axial_length.instrument_id) {
            const m = await tx.measurement.create({
              data: {
                patient_id: patientId,
                date: new Date(visitFields.visit_date),
                instrument_id: axial_length.instrument_id,
                od: axial_length.od ?? null,
                os: axial_length.os ?? null,
                creator_id: userId,
              },
            });
            measurementId = m.id;
          }
        }

        const visit = await tx.study_visit.update({
          where: { id: visitId },
          data: {
            // Pass values as-is: an omitted (undefined) field is skipped by
            // Prisma so the existing value is kept, while an explicit null
            // clears it (N.D.). Using `?? null` here would wipe every field a
            // partial PATCH left out.
            visit_date: new Date(visitFields.visit_date),
            va_od: visitFields.va_od,
            va_os: visitFields.va_os,
            bcva_od: visitFields.bcva_od,
            bcva_os: visitFields.bcva_os,
            refraction_method: visitFields.refraction_method,
            ref_od_sph: visitFields.ref_od_sph,
            ref_od_cyl: visitFields.ref_od_cyl,
            ref_od_axis: visitFields.ref_od_axis,
            ref_os_sph: visitFields.ref_os_sph,
            ref_os_cyl: visitFields.ref_os_cyl,
            ref_os_axis: visitFields.ref_os_axis,
            slitlamp_od_normal: visitFields.slitlamp_od_normal,
            slitlamp_od_finding: visitFields.slitlamp_od_finding,
            slitlamp_os_normal: visitFields.slitlamp_os_normal,
            slitlamp_os_finding: visitFields.slitlamp_os_finding,
            iop_od: visitFields.iop_od,
            iop_os: visitFields.iop_os,
            accom_od: visitFields.accom_od,
            accom_os: visitFields.accom_os,
            measurement_id: measurementId,
            concomitant_meds: visitFields.concomitant_meds,
            adverse_event: visitFields.adverse_event,
          },
        });

        await writeAuditLog({
          ...ctx,
          tableName: "study_visit",
          recordId: visit.id,
          action: "UPDATE",
          hospitalId,
          patientId,
          oldValue: existing,
          newValue: visit,
          client: tx,
        });
        return visit;
      });

      res.json(updated);
    } catch (error) {
      await writeAuditFailure(
        {
          ...ctx,
          tableName: "study_visit",
          recordId: visitId,
          action: "UPDATE",
          hospitalId,
          patientId,
          newValue: data,
        },
        error,
      );
      throw error;
    }
  },
);

// DELETE /study/enrollment/:enrollmentId/visit/:visitId — delete a visit record.
// The linked axial-length `measurement` is intentionally kept (it belongs to
// the main growth chart, not the study visit).
router.delete(
  "/enrollment/:enrollmentId/visit/:visitId",
  approvedProfessionalRequired,
  async (req, res) => {
    const hospitalId = req.healthcare_professional!.hospital_id;
    const enrollment = await authorizeEnrollment(
      String(req.params.enrollmentId),
      hospitalId,
    );
    if (!enrollment) {
      res.sendStatus(404);
      return;
    }
    const visitId = String(req.params.visitId);
    const existing = await prisma.study_visit.findFirst({
      where: { id: visitId, enrollment_id: enrollment.id },
    });
    if (!existing) {
      res.sendStatus(404);
      return;
    }

    const patientId = enrollment.patient.id;
    const ctx = auditContextFromRequest(req);
    try {
      await prisma.$transaction(async (tx) => {
        await tx.study_visit.delete({ where: { id: visitId } });
        await writeAuditLog({
          ...ctx,
          tableName: "study_visit",
          recordId: visitId,
          action: "DELETE",
          hospitalId,
          patientId,
          oldValue: existing,
          client: tx,
        });
      });
      res.sendStatus(204);
    } catch (error) {
      await writeAuditFailure(
        {
          ...ctx,
          tableName: "study_visit",
          recordId: visitId,
          action: "DELETE",
          hospitalId,
          patientId,
        },
        error,
      );
      throw error;
    }
  },
);

export default router;
