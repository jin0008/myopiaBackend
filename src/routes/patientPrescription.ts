import express from "express";
import zod from "zod";
import { Prisma, audit_action, sex } from "@prisma/client";

import prisma from "../lib/prisma";
import { hospitalDisplayName } from "../lib/hospitalName";
import { approvedProfessionalRequired, hospitalAdminRequired, validateRequestBody } from "../lib/middlewares";
import { hashRegistrationNumber } from "../lib/hash";
import { validationBody } from "../lib/validationError";
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
// 칸 이름(path)을 달아 화면이 어느 칸인지 짚을 수 있게 한다.
const eyeSchema = zod.object(eyeFields).superRefine((e, ctx) => {
  for (const eye of ["od", "os"] as const) {
    if (e[`prism_${eye}`] && !e[`base_${eye}`]) ctx.addIssue({ code: "custom", path: [`base_${eye}`], message: "프리즘을 넣으면 BASE 방향도 골라 주세요." });
    if (e[`cyl_${eye}`] && e[`axis_${eye}`] == null) ctx.addIssue({ code: "custom", path: [`axis_${eye}`], message: "CYL 을 넣으면 축(AXIS)도 넣어 주세요." });
  }
});
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
  /** REMARKS 칩으로 고른 것(렌즈 제품·용도). */
  remark_tags: zod.array(zod.string().trim().min(1).max(40)).max(20).optional(),
  /** 병원 설정의 처방의 목록에서 고른 의사. 없으면 발행한 로그인 의료인 이름. */
  prescriber_name: zod.string().trim().min(1).max(50).optional(),
  prescriber_license: zod.string().trim().max(30).nullable().optional(),
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
  remark_tags: r.remark_tags,
  prescriber_license: r.prescriber_license,
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
        date_of_birth: dateOnly(await decryptSymmetric(patient.encrypted_date_of_birth)),
        sex: patient.sex,
        linked: await isLinked(patient.id),
      },
    });
  },
);

/** 저장된 생년월일은 옛 행에 시각이 붙어 있기도 하다("2015-03-02T00:00:00.000Z"). 날짜만 본다. */
const dateOnly = (v: string) => v.slice(0, 10);

/**
 * POST /patient/prescriptions — 환자 확인(없으면 생성)과 처방 저장을 한 트랜잭션으로.
 * 앱과 이어지지 않은 환자면 연동 초대 링크를 만들어 같이 준다(처방전에 QR 로 찍는다).
 */
router.post("/", approvedProfessionalRequired, async (req, res) => {
  const hp = req.healthcare_professional!;
  // 어느 칸이 왜 틀렸는지 화면에 짚어 줘야 한다. 칸이 마흔 개 가까이라
  // "invalid body" 만으로는 고칠 곳을 못 찾는다.
  const parsed = postSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json(validationBody(parsed.error));
    return;
  }
  const d: PostBody = parsed.data;
  const hash = hashRegistrationNumber(d.registration_number);
  const key = { registration_number_hash_hospital_id: { registration_number_hash: hash, hospital_id: hp.hospital_id } };

  // 처방의는 병원 양식의 처방의 목록에 있는 이름·면허번호여야 한다. 아무 이름이나
  // 받으면 다른 의사 이름·면허로 공식 처방전을 찍을 수 있다.
  if (d.prescriber_name) {
    const setting = await prisma.hospital_rx_setting.findUnique({ where: { hospital_id: hp.hospital_id } });
    const doctors = ((setting?.settings as { doctors?: { name?: string; license?: string }[] } | null)?.doctors ?? []);
    const ok = doctors.some((x) => (x.name ?? "").trim() === d.prescriber_name && (x.license ?? "").trim() === (d.prescriber_license ?? ""));
    if (!ok) {
      res.status(400).json({ message: "처방의 목록에 없는 의사입니다. 설정에서 처방의를 확인해 주세요.", fields: [{ path: "prescriber_name", message: "처방의 목록에 없습니다." }] });
      return;
    }
  }

  // KMS(암호화·복호화)는 트랜잭션 밖에서 한다. 안에서 부르면 왕복 동안 트랜잭션이
  // 열려 있다. 기존 환자면 생년월일만 풀어 대조하고, 새 환자일 때만 암호화한다.
  const existing = await prisma.patient.findUnique({ where: key });
  if (existing) {
    const mismatch: string[] = [];
    if (dateOnly(await decryptSymmetric(existing.encrypted_date_of_birth)) !== d.date_of_birth) mismatch.push("date_of_birth");
    if (existing.sex !== d.sex) mismatch.push("sex");
    if (mismatch.length) {
      res.status(409).json({ message: "차트번호의 환자 정보와 생년월일·성별이 다릅니다.", code: "patient_mismatch", fields: mismatch.map((path) => ({ path, message: "등록된 환자 정보와 다릅니다." })) });
      return;
    }
  }
  const ethnicityId = existing ? null : (d.ethnicity_id ?? (await defaultEthnicityId(hp.default_ethnicity_id)));
  if (!existing && !ethnicityId) {
    res.status(400).json({ message: "인종 기본값이 없습니다. 프로필에서 기본 인종을 정해 주세요.", code: "ethnicity_required", fields: [{ path: "ethnicity_id", message: "인종 기본값이 없습니다. 프로필에서 기본 인종을 정해 주세요." }] });
    return;
  }
  const enc = existing ? null : await Promise.all([encryptSymmetric(d.registration_number), encryptSymmetric(d.date_of_birth)]);

  const run = () =>
    prisma.$transaction(async (tx) => {
      let patient = existing;
      let created = false;
      if (!patient) {
        // 그 사이 같은 번호로 누가 먼저 만들었으면 유니크에 걸린다(P2002) - 아래에서 한 번 다시 돈다.
        patient = await tx.patient.create({
          data: {
            sex: d.sex,
            ethnicity_id: ethnicityId!,
            encrypted_registration_number: Uint8Array.from(enc![0]),
            registration_number_hash: hash,
            encrypted_date_of_birth: Uint8Array.from(enc![1]),
            hospital_id: hp.hospital_id,
            creator_id: req.authSession!.user_id,
          },
        });
        created = true;
        // 차트번호·생년월일은 감사로그에 남기지 않는다(POST /patient 와 같다).
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
          prescriber_name: d.prescriber_name ?? hp.name,
          prescriber_license: d.prescriber_name ? (d.prescriber_license ?? null) : null,
          prescribed_on: new Date(d.prescribed_on),
          ...eyeColumns("far", d.far),
          ...eyeColumns("near", d.near),
          pd_far: d.pd_far ?? null,
          pd_near: d.pd_near ?? null,
          add_od: d.add_od ?? null,
          add_os: d.add_os ?? null,
          note: d.note || null,
          remark_tags: [...new Set(d.remark_tags ?? [])],
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
    });

  let result: Awaited<ReturnType<typeof run>>;
  try {
    result = await run();
  } catch (e) {
    // 같은 차트번호로 두 사람이 동시에 처음 발행하면 한쪽이 유니크에 걸린다.
    // 다시 발행하면 기존 환자로 잡혀 생년월일 대조를 거친다.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      res.status(409).json({ message: "같은 차트번호로 방금 환자가 등록됐습니다. 다시 발행해 주세요.", code: "retry" });
      return;
    }
    throw e;
  }

  // 초대는 처방이 저장된 뒤에 만든다. 실패해도 처방은 유효하고, 환자 화면에서
  // 다시 발급할 수 있다.
  let invite: { url: string; expires_at: string } | null = null;
  if (!(await isLinked(result.patient.id))) {
    try {
      // 앞서 준 링크는 무효로 하지 않는다. 링크는 처방전 종이에 찍혀 나가므로, 같은 날
      // 두 번째 처방(근용 등)을 발행했다고 첫 종이의 QR 이 죽으면 안 된다. 각 링크는
      // 한 번만 쓰인다.
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
  // 같은 환자의 차트번호는 한 번만 푼다(KMS 왕복).
  const regNo = new Map<string, Promise<string>>();
  for (const r of rows) if (!regNo.has(r.patient_id)) regNo.set(r.patient_id, decryptSymmetric(r.patient.encrypted_registration_number));
  const out = await Promise.all(
    rows.map(async ({ patient, ...r }) => ({
      ...prescriptionDTO(r),
      registration_number: await regNo.get(r.patient_id)!,
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

/* 병원별 처방전 양식. 모양(키)은 화면이 정하고, 서버는 크기만 막는다.
 * 로고·도장 이미지가 data URL 로 들어 있어 index.ts 에서 이 경로만 JSON 한도를 올린다. */
// nginx 기본 본문 한도(1m)보다 작게 - 넘으면 nginx 가 먼저 HTML 413 을 돌려 이 안내가 안 보인다.
const SETTINGS_MAX_BYTES = 900_000;

/** GET /patient/prescriptions/settings — 없으면 null(화면이 기본값을 쓴다). */
router.get("/settings", approvedProfessionalRequired, async (req, res) => {
  const row = await prisma.hospital_rx_setting.findUnique({
    where: { hospital_id: req.healthcare_professional!.hospital_id },
  });
  res.json({ settings: row?.settings ?? null, updated_at: row?.updated_at ?? null });
});

/** PUT /patient/prescriptions/settings {settings} — 병원 관리자만. 처방의 목록·면허번호·도장이
 *  병원 전체 처방전에 찍히므로 아무 직원이나 바꾸면 안 된다. */
router.put("/settings", hospitalAdminRequired, async (req, res) => {
  const settings = req.body?.settings;
  if (settings == null || typeof settings !== "object" || Array.isArray(settings)) {
    res.status(400).json({ message: "settings 가 필요합니다." });
    return;
  }
  if (JSON.stringify(settings).length > SETTINGS_MAX_BYTES) {
    res.status(413).json({ message: "로고·도장 이미지가 너무 큽니다. 더 작은 이미지를 써 주세요." });
    return;
  }
  const hospitalId = req.healthcare_professional!.hospital_id;
  await prisma.hospital_rx_setting.upsert({
    where: { hospital_id: hospitalId },
    create: { hospital_id: hospitalId, settings, updated_by: hp(req) },
    update: { settings, updated_by: hp(req) },
  });
  writeAuditLog({
    ...auditContextFromRequest(req),
    tableName: "hospital_rx_setting",
    action: audit_action.UPDATE,
    hospitalId,
  }).catch(console.error);
  res.sendStatus(204);
});
const hp = (req: express.Request) => req.healthcare_professional!.user_id;

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
      date_of_birth: dateOnly(await decryptSymmetric(patient.encrypted_date_of_birth)),
      sex: patient.sex,
      linked: await isLinked(r.patient_id),
    },
    hospital: { name: hospitalDisplayName(hospital), address: hospital.address, phone: hospital.phone },
  });
});

export default router;
