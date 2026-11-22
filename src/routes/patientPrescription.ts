import express from "express";
import zod from "zod";
import { Prisma, audit_action, sex } from "@prisma/client";

import prisma from "../lib/prisma";
import { hospitalDisplayName } from "../lib/hospitalName";
import { approvedProfessionalRequired, validateRequestBody } from "../lib/middlewares";
import { hashRegistrationNumber } from "../lib/hash";
import { decryptSymmetric, encryptSymmetric } from "../services/encrpytion";
import { auditContextFromRequest, writeAuditLog } from "../services/audit";
import { createLinkInvite } from "../services/linkInvite";

/**
 * 병원이 발행하는 안경 처방전. /patient 보다 먼저 붙인다 - 거기의
 * GET /:patientId 가 "prescriptions" 를 환자 id 로 잡아먹는다.
 *
 * 처방전은 진료실에서 바로 쓰는 화면이라 환자 등록과 처방을 한 번에 받는다.
 * 등록번호로 찾고, 없으면 그 자리에서 환자를 만든다.
 */
const router = express.Router();

const todayKst = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);

/** 0.25D 단위. 처방 도수는 이 단위로만 나온다 - 0.3 같은 값은 오타다. */
const quarter = (min: number, max: number, label: string) =>
  zod
    .number()
    .min(min, `${label}는 ${min}~${max} 사이여야 합니다.`)
    .max(max, `${label}는 ${min}~${max} 사이여야 합니다.`)
    .refine((v) => Number.isInteger(Math.round(v * 1000) / 250), `${label}는 0.25 단위여야 합니다.`)
    .nullable()
    .optional();

const axis = zod.number().int("축은 0~180 사이 정수여야 합니다.").min(0).max(180).nullable().optional();
const prism = zod.number().min(0).max(30, "프리즘은 0~30Δ 사이여야 합니다.").nullable().optional();
const base = zod.enum(["BI", "BO", "BU", "BD"]).nullable().optional();
const pd = zod.number().min(40, "PD 는 40~80mm 사이여야 합니다.").max(80, "PD 는 40~80mm 사이여야 합니다.").nullable().optional();

const eyeFields = {
  sph_od: quarter(-30, 30, "SPH"),
  sph_os: quarter(-30, 30, "SPH"),
  cyl_od: quarter(-10, 10, "CYL"),
  cyl_os: quarter(-10, 10, "CYL"),
  axis_od: axis,
  axis_os: axis,
  prism_od: prism,
  prism_os: prism,
  base_od: base,
  base_os: base,
};
const eyeSchema = zod
  .object(eyeFields)
  .refine((e) => !(e.prism_od && !e.base_od) && !(e.prism_os && !e.base_os), "프리즘을 넣으면 BASE 방향도 골라 주세요.")
  .refine((e) => !(e.cyl_od && e.axis_od == null) && !(e.cyl_os && e.axis_os == null), "CYL 을 넣으면 축(AXIS)도 넣어 주세요.");
type Eye = zod.infer<typeof eyeSchema>;

export const postSchema = zod.object({
  registration_number: zod.string().trim().min(1).max(50),
  date_of_birth: zod.string().date(),
  sex: zod.nativeEnum(sex),
  /** 신규 환자일 때만 쓴다. 없으면 의료인 기본값, 그것도 없으면 동아시아인. */
  ethnicity_id: zod.string().uuid().optional(),
  prescribed_on: zod
    .string()
    .date()
    .refine((d) => d <= todayKst(), "앞으로의 날짜로는 발행할 수 없습니다."),
  far: eyeSchema.optional(),
  near: eyeSchema.optional(),
  pd_far: pd,
  pd_near: pd,
  add_od: quarter(0, 4, "ADD"),
  add_os: quarter(0, 4, "ADD"),
  note: zod.string().trim().max(500).nullable().optional(),
});
type PostBody = zod.infer<typeof postSchema>;

const eyeColumns = (prefix: "far" | "near", e: Eye | undefined) => ({
  [`${prefix}_sph_od`]: e?.sph_od ?? null,
  [`${prefix}_sph_os`]: e?.sph_os ?? null,
  [`${prefix}_cyl_od`]: e?.cyl_od ?? null,
  [`${prefix}_cyl_os`]: e?.cyl_os ?? null,
  [`${prefix}_axis_od`]: e?.axis_od ?? null,
  [`${prefix}_axis_os`]: e?.axis_os ?? null,
  [`${prefix}_prism_od`]: e?.prism_od || null,
  [`${prefix}_prism_os`]: e?.prism_os || null,
  [`${prefix}_base_od`]: e?.prism_od ? e.base_od ?? null : null,
  [`${prefix}_base_os`]: e?.prism_os ? e.base_os ?? null : null,
});

type Row = Prisma.patient_prescriptionGetPayload<object>;

const eyeDTO = (r: Row, p: "far" | "near") => ({
  sph_od: r[`${p}_sph_od`],
  sph_os: r[`${p}_sph_os`],
  cyl_od: r[`${p}_cyl_od`],
  cyl_os: r[`${p}_cyl_os`],
  axis_od: r[`${p}_axis_od`],
  axis_os: r[`${p}_axis_os`],
  prism_od: r[`${p}_prism_od`],
  prism_os: r[`${p}_prism_os`],
  base_od: r[`${p}_base_od`],
  base_os: r[`${p}_base_os`],
});

/** 병원 화면과 앱이 같은 모양을 쓴다. */
export const prescriptionDTO = (r: Row) => ({
  id: r.id,
  patient_id: r.patient_id,
  prescriber_name: r.prescriber_name,
  prescribed_on: r.prescribed_on.toISOString().slice(0, 10),
  far: eyeDTO(r, "far"),
  near: eyeDTO(r, "near"),
  pd_far: r.pd_far,
  pd_near: r.pd_near,
  add_od: r.add_od,
  add_os: r.add_os,
  note: r.note,
  created_at: r.created_at.toISOString(),
});

async function defaultEthnicityId(hpDefault: string | null | undefined): Promise<string | null> {
  if (hpDefault) return hpDefault;
  const row = await prisma.ethnicity.findFirst({
    where: { OR: [{ name: { contains: "east asian", mode: "insensitive" } }, { name: { contains: "korean", mode: "insensitive" } }] },
    select: { id: true },
  });
  return row?.id ?? null;
}

const isLinked = async (patientId: string) =>
  (await prisma.child_hospital_link.count({ where: { patient_id: patientId, status: "active" } })) > 0;

/**
 * POST /patient/prescriptions/lookup — 등록번호로 기존 환자를 찾는다.
 * 처방전 화면이 생년월일·성별을 채워 주려고 부른다. 등록번호를 주소에
 * 남기지 않으려고 GET 이 아니라 POST 다.
 */
router.post(
  "/lookup",
  approvedProfessionalRequired,
  validateRequestBody(zod.object({ registration_number: zod.string().trim().min(1).max(50) })),
  async (req, res) => {
    const hospitalId = req.healthcare_professional!.hospital_id;
    const patient = await prisma.patient.findUnique({
      where: {
        registration_number_hash_hospital_id: {
          registration_number_hash: hashRegistrationNumber(req.body.registration_number),
          hospital_id: hospitalId,
        },
      },
    });
    if (patient == null) {
      res.json({ exists: false });
      return;
    }
    writeAuditLog({
      ...auditContextFromRequest(req),
      tableName: "patient",
      recordId: patient.id,
      action: audit_action.READ,
      hospitalId,
      patientId: patient.id,
      newValue: { scope: "prescription_lookup" },
    }).catch(console.error);
    res.json({
      exists: true,
      patient: {
        id: patient.id,
        date_of_birth: await decryptSymmetric(patient.encrypted_date_of_birth),
        sex: patient.sex,
        linked: await isLinked(patient.id),
      },
    });
  },
);

class PatientMismatch extends Error {
  constructor(public fields: string[]) {
    super("patient mismatch");
  }
}

/**
 * POST /patient/prescriptions — 환자 확인(없으면 생성)과 처방 저장을 한 트랜잭션으로.
 * 앱과 이어지지 않은 환자면 연동 초대 링크를 만들어 같이 준다(처방전에 QR 로 찍는다).
 */
router.post("/", approvedProfessionalRequired, validateRequestBody(postSchema), async (req, res) => {
  const hp = req.healthcare_professional!;
  const d = req.body as PostBody;
  const hash = hashRegistrationNumber(d.registration_number);
  // 암호화(KMS)는 트랜잭션 밖에서 미리 한다. 안에서 부르면 왕복이 쌓여
  // 트랜잭션 제한시간(기본 5초)에 걸릴 수 있다. 기존 환자면 안 쓰고 버린다.
  const [encRegNo, encDob] = await Promise.all([
    encryptSymmetric(d.registration_number),
    encryptSymmetric(d.date_of_birth),
  ]);

  const run = () =>
    prisma.$transaction(async (tx) => {
      let patient = await tx.patient.findUnique({
        where: { registration_number_hash_hospital_id: { registration_number_hash: hash, hospital_id: hp.hospital_id } },
      });
      let created = false;
      if (patient) {
        // 등록번호를 잘못 친 경우를 잡는다. 남의 차트에 처방이 붙으면 그 보호자 앱에 뜬다.
        const mismatch: string[] = [];
        if ((await decryptSymmetric(patient.encrypted_date_of_birth)) !== d.date_of_birth) mismatch.push("date_of_birth");
        if (patient.sex !== d.sex) mismatch.push("sex");
        if (mismatch.length) throw new PatientMismatch(mismatch);
      } else {
        const ethnicityId = d.ethnicity_id ?? (await defaultEthnicityId(hp.default_ethnicity_id));
        if (!ethnicityId) throw new PatientMismatch(["ethnicity_id"]);
        patient = await tx.patient.create({
          data: {
            sex: d.sex,
            ethnicity_id: ethnicityId,
            encrypted_registration_number: Uint8Array.from(encRegNo),
            registration_number_hash: hash,
            encrypted_date_of_birth: Uint8Array.from(encDob),
            hospital_id: hp.hospital_id,
            creator_id: req.authSession!.user_id,
          },
        });
        created = true;
        // 등록번호·생년월일은 감사로그에 남기지 않는다(POST /patient 와 같다).
        await writeAuditLog({
          ...auditContextFromRequest(req),
          client: tx,
          tableName: "patient",
          recordId: patient.id,
          action: audit_action.CREATE,
          hospitalId: hp.hospital_id,
          patientId: patient.id,
          newValue: { sex: patient.sex, ethnicity_id: patient.ethnicity_id, via: "prescription" },
        });
      }

      const rx = await tx.patient_prescription.create({
        data: {
          patient_id: patient.id,
          hospital_id: hp.hospital_id,
          prescriber_id: hp.user_id,
          prescriber_name: hp.name,
          prescribed_on: new Date(d.prescribed_on),
          ...eyeColumns("far", d.far),
          ...eyeColumns("near", d.near),
          pd_far: d.pd_far ?? null,
          pd_near: d.pd_near ?? null,
          add_od: d.add_od ?? null,
          add_os: d.add_os ?? null,
          note: d.note || null,
        },
      });
      await writeAuditLog({
        ...auditContextFromRequest(req),
        client: tx,
        tableName: "patient_prescription",
        recordId: rx.id,
        action: audit_action.CREATE,
        hospitalId: hp.hospital_id,
        patientId: patient.id,
      });
      return { patient, rx, created };
    }, { timeout: 15_000 });

  let result: Awaited<ReturnType<typeof run>>;
  try {
    try {
      result = await run();
    } catch (e) {
      // 같은 등록번호로 두 사람이 동시에 처음 발행하면 한쪽이 유니크에 걸린다.
      // 다시 돌면 이번엔 기존 환자로 잡혀 생년월일 확인을 거친다.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") result = await run();
      else throw e;
    }
  } catch (e) {
    if (e instanceof PatientMismatch) {
      const ethnicity = e.fields.includes("ethnicity_id");
      res.status(ethnicity ? 400 : 409).json({
        error: ethnicity ? "인종 기본값이 없습니다. 환자 인종을 골라 주세요." : "등록번호의 환자 정보와 생년월일·성별이 다릅니다.",
        code: ethnicity ? "ethnicity_required" : "patient_mismatch",
        fields: e.fields,
      });
      return;
    }
    throw e;
  }

  // 초대는 처방이 저장된 뒤에 만든다. 실패해도 처방은 유효하고, 환자 화면에서
  // 다시 발급할 수 있다.
  let invite: { url: string; expires_at: string } | null = null;
  if (!(await isLinked(result.patient.id))) {
    try {
      // 살아 있는 링크가 여럿이면 어느 것이 유효한지 아무도 모른다(link-invite 와 같다).
      await prisma.child_link_invite.updateMany({
        where: { patient_id: result.patient.id, used_at: null, revoked_at: null },
        data: { revoked_at: new Date() },
      });
      const made = await createLinkInvite({ hospitalId: hp.hospital_id, patientId: result.patient.id, createdBy: hp.user_id });
      invite = { url: made.url, expires_at: made.expiresAt.toISOString() };
      writeAuditLog({
        ...auditContextFromRequest(req),
        action: audit_action.CREATE,
        tableName: "child_link_invite",
        hospitalId: hp.hospital_id,
        patientId: result.patient.id,
      }).catch(console.error);
    } catch (e) {
      console.error("[prescription] invite failed", e);
    }
  }

  res.status(201).json({
    prescription: prescriptionDTO(result.rx),
    patient_created: result.created,
    invite,
  });
});

/** GET /patient/prescriptions?patient_id=…&limit=… — 자기 병원 처방만, 최근 발행 순. */
router.get("/", approvedProfessionalRequired, async (req, res) => {
  const hospitalId = req.healthcare_professional!.hospital_id;
  const patientId = typeof req.query.patient_id === "string" ? req.query.patient_id : undefined;
  if (patientId && !zod.string().uuid().safeParse(patientId).success) {
    res.sendStatus(400);
    return;
  }
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
  const rows = await prisma.patient_prescription.findMany({
    where: { hospital_id: hospitalId, ...(patientId && { patient_id: patientId }) },
    include: { patient: { select: { encrypted_registration_number: true, sex: true } } },
    orderBy: { created_at: "desc" },
    take: limit,
  });
  const out = await Promise.all(
    rows.map(async ({ patient, ...r }) => ({
      ...prescriptionDTO(r),
      registration_number: await decryptSymmetric(patient.encrypted_registration_number),
      sex: patient.sex,
    })),
  );
  writeAuditLog({
    ...auditContextFromRequest(req),
    tableName: "patient_prescription",
    action: audit_action.READ,
    hospitalId,
    patientId: patientId ?? null,
    newValue: { scope: "prescription_list", count: out.length },
  }).catch(console.error);
  res.json(out);
});

/** GET /patient/prescriptions/:id — 인쇄용. 환자·병원 정보와 연동 여부를 같이 준다. */
router.get("/:id", approvedProfessionalRequired, async (req, res) => {
  const hospitalId = req.healthcare_professional!.hospital_id;
  const id = String(req.params.id);
  if (!zod.string().uuid().safeParse(id).success) {
    res.sendStatus(404);
    return;
  }
  const row = await prisma.patient_prescription.findFirst({
    where: { id, hospital_id: hospitalId },
    include: {
      patient: { select: { encrypted_registration_number: true, encrypted_date_of_birth: true, sex: true } },
      hospital: { select: { name: true, name_ko: true, address: true, phone: true } },
    },
  });
  if (row == null) {
    res.sendStatus(404);
    return;
  }
  const { patient, hospital, ...r } = row;
  writeAuditLog({
    ...auditContextFromRequest(req),
    tableName: "patient_prescription",
    recordId: r.id,
    action: audit_action.READ,
    hospitalId,
    patientId: r.patient_id,
  }).catch(console.error);
  res.json({
    ...prescriptionDTO(r),
    patient: {
      registration_number: await decryptSymmetric(patient.encrypted_registration_number),
      date_of_birth: await decryptSymmetric(patient.encrypted_date_of_birth),
      sex: patient.sex,
      linked: await isLinked(r.patient_id),
    },
    hospital: { name: hospitalDisplayName(hospital), address: hospital.address, phone: hospital.phone },
  });
});

export default router;
