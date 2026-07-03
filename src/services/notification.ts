import prisma from "../lib/prisma";
import { sex } from "@prisma/client";
import {
  AXIAL_LENGTH_ALERT,
  AXIAL_QUERY,
  PROGRESSION_ALERT,
  SE_ALERT,
} from "../lib/constants";
import { decryptSymmetric } from "./encrpytion";
import { sendEmail } from "./email";

const MS_PER_YEAR = 1000 * 60 * 60 * 24 * 365.25;

interface AlertMeasurement {
  id: string;
  patient_id: string;
  date: Date;
  od: number | null;
  os: number | null;
}

interface AlertRefractiveError {
  id: string;
  patient_id: string;
  date: Date;
  od_sph: number | null;
  od_cyl: number | null;
  os_sph: number | null;
  os_cyl: number | null;
}

/** Spherical equivalent = sphere + cylinder / 2 (dioptres). */
function sphericalEquivalent(
  sph: number | null,
  cyl: number | null,
): number | null {
  if (sph == null) return null;
  return sph + (cyl ?? 0) / 2;
}

/** Fractional years between two dates (>= 0), or null if not strictly later. */
function yearsBetween(earlier: Date, later: Date): number | null {
  const ms = later.getTime() - earlier.getTime();
  if (ms <= 0) return null;
  return ms / MS_PER_YEAR;
}

/**
 * Recipients for a hospital's alerts: its `is_admin` professionals whose user
 * has opted in via `receive_email_updates`.
 */
async function getHospitalAlertRecipients(
  hospitalId: string,
): Promise<string[]> {
  const admins = await prisma.healthcare_professional.findMany({
    where: {
      hospital_id: hospitalId,
      is_admin: true,
      user: { receive_email_updates: true },
    },
    select: { user: { select: { email: true } } },
  });
  return admins
    .map((admin) => admin.user.email)
    .filter((email): email is string => email != null && email.length > 0);
}

/** Whether Cloud KMS is configured, so PII decryption can be attempted. */
function isEncryptionConfigured(): boolean {
  return Boolean(
    process.env.GOOGLE_CLOUD_PROJECT_ID &&
      process.env.GOOGLE_CLOUD_LOCATION_ID &&
      process.env.GOOGLE_CLOUD_KEY_RING_ID &&
      process.env.GOOGLE_CLOUD_CRYPTO_KEY_ID,
  );
}

/** Patient age in whole years at `atDate`, or null if DOB can't be resolved. */
async function patientAgeYears(
  encryptedDob: Uint8Array,
  atDate: Date,
): Promise<number | null> {
  // Skip decryption entirely when KMS isn't configured (e.g. local env): the
  // age-based threshold falls back to the default and progression checks (which
  // need no PII) still run.
  if (!isEncryptionConfigured()) return null;
  try {
    const dobString = await decryptSymmetric(encryptedDob);
    const dob = new Date(dobString);
    if (Number.isNaN(dob.getTime())) return null;
    const years = (atDate.getTime() - dob.getTime()) / MS_PER_YEAR;
    return years >= 0 ? Math.floor(years) : null;
  } catch (err) {
    // Decryption needs KMS; if unavailable we fall back to the default
    // threshold rather than failing the alert.
    console.error("patientAgeYears: failed to resolve DOB:", err);
    return null;
  }
}

/** Age/sex-specific axial length warning max (mm), or the global fallback. */
async function getAxialThreshold(
  age: number | null,
  patientSex: sex,
): Promise<number> {
  if (age != null) {
    const row = await prisma.axial_length_threshold.findUnique({
      where: { age_sex: { age, sex: patientSex } },
      select: { warn_max: true },
    });
    if (row != null) return row.warn_max;
  }
  return AXIAL_LENGTH_ALERT.max;
}

/**
 * Checks a new/updated axial length measurement against (1) the age-based
 * absolute threshold and (2) the myopia progression rate vs. the previous
 * measurement, and emails the hospital's admins if either is breached.
 */
export async function checkMeasurementAlerts(
  measurement: AlertMeasurement,
): Promise<void> {
  const patient = await prisma.patient.findUnique({
    where: { id: measurement.patient_id },
    select: { hospital_id: true },
  });
  if (patient == null) return;

  const reasons: string[] = [];

  // Most recent measurement before this one, for change-based checks.
  const previous = await prisma.measurement.findFirst({
    where: {
      patient_id: measurement.patient_id,
      id: { not: measurement.id },
      date: { lt: measurement.date },
    },
    orderBy: { date: "desc" },
    select: { date: true, od: true, os: true },
  });

  for (const eye of ["od", "os"] as const) {
    const value = measurement[eye];
    if (value == null) continue;
    const label = eye.toUpperCase();

    // (1) Outside the normal absolute range.
    if (value <= AXIAL_QUERY.minNormal || value >= AXIAL_QUERY.maxNormal) {
      reasons.push(
        `안축장 ${label} ${value}mm — 기준 범위(${AXIAL_QUERY.minNormal.toFixed(1)}~${AXIAL_QUERY.maxNormal.toFixed(1)}mm)를 벗어났습니다.`,
      );
    }

    const prev = previous?.[eye];
    if (previous == null || prev == null) continue;
    const prevDate = previous.date.toISOString().slice(0, 10);

    // (2) Decreased vs. the previous measurement (e.g. atropine effect).
    const decrease = prev - value;
    if (decrease >= AXIAL_QUERY.decreaseMm) {
      reasons.push(
        `안축장 ${label}가 직전 측정(${prevDate}, ${prev}mm) 대비 ${decrease.toFixed(2)}mm 감소했습니다.`,
      );
    }

    // (3) Increasing too fast vs. the previous measurement.
    const years = yearsBetween(previous.date, measurement.date);
    if (years != null && years > 0) {
      const rate = (value - prev) / years;
      if (rate >= AXIAL_QUERY.increaseMmPerYear) {
        reasons.push(
          `안축장 ${label} 증가 속도가 ${rate.toFixed(2)}mm/year로 기준(${AXIAL_QUERY.increaseMmPerYear.toFixed(1)}mm/year)을 초과했습니다.`,
        );
      }
    }
  }

  if (reasons.length === 0) return;

  await emailAlert(patient.hospital_id, {
    title: "안축장 알림",
    patientId: measurement.patient_id,
    date: measurement.date,
    reasons,
  });
}

/**
 * Checks a new/updated refractive error against (1) the absolute spherical
 * equivalent threshold (high myopia) and (2) the SE progression rate vs. the
 * previous record, and emails the hospital's admins if either is breached.
 */
export async function checkRefractiveErrorAlerts(
  refractiveError: AlertRefractiveError,
): Promise<void> {
  const patient = await prisma.patient.findUnique({
    where: { id: refractiveError.patient_id },
    select: { hospital_id: true },
  });
  if (patient == null) return;

  const seOd = sphericalEquivalent(
    refractiveError.od_sph,
    refractiveError.od_cyl,
  );
  const seOs = sphericalEquivalent(
    refractiveError.os_sph,
    refractiveError.os_cyl,
  );

  const reasons: string[] = [];

  // (1) Absolute SE threshold (high myopia).
  if (seOd != null && seOd <= SE_ALERT.min) {
    reasons.push(
      `SE OD ${seOd.toFixed(2)}D 가 고도근시 임계(${SE_ALERT.min}D) 이하입니다.`,
    );
  }
  if (seOs != null && seOs <= SE_ALERT.min) {
    reasons.push(
      `SE OS ${seOs.toFixed(2)}D 가 고도근시 임계(${SE_ALERT.min}D) 이하입니다.`,
    );
  }

  // (2) SE progression (myopic shift) vs. the previous record.
  const previous = await prisma.refractive_error.findFirst({
    where: {
      patient_id: refractiveError.patient_id,
      id: { not: refractiveError.id },
      date: { lt: refractiveError.date },
    },
    orderBy: { date: "desc" },
    select: { date: true, od_sph: true, od_cyl: true, os_sph: true, os_cyl: true },
  });
  if (previous != null) {
    const years = yearsBetween(previous.date, refractiveError.date);
    if (years != null) {
      const eyes = [
        { label: "OD", curr: seOd, prev: sphericalEquivalent(previous.od_sph, previous.od_cyl) },
        { label: "OS", curr: seOs, prev: sphericalEquivalent(previous.os_sph, previous.os_cyl) },
      ];
      for (const { label, curr, prev } of eyes) {
        if (curr == null || prev == null) continue;
        // Myopic shift = SE decreasing; report magnitude per year.
        const shiftPerYear = (prev - curr) / years;
        if (shiftPerYear >= PROGRESSION_ALERT.seDioptersPerYear) {
          reasons.push(
            `SE ${label} 진행속도 ${shiftPerYear.toFixed(2)}D/년 ` +
              `(임계 ${PROGRESSION_ALERT.seDioptersPerYear}D/년)으로 빠르게 진행 중입니다.`,
          );
        }
      }
    }
  }

  if (reasons.length === 0) return;

  await emailAlert(patient.hospital_id, {
    title: "굴절이상(SE) 알림",
    patientId: refractiveError.patient_id,
    date: refractiveError.date,
    reasons,
  });
}

async function emailAlert(
  hospitalId: string,
  alert: { title: string; patientId: string; date: Date; reasons: string[] },
): Promise<void> {
  const recipients = await getHospitalAlertRecipients(hospitalId);
  if (recipients.length === 0) return;

  const measuredDate = alert.date.toISOString().slice(0, 10);
  // Deep link to the patient record. The email itself carries NO patient
  // identifier (registration number / DOB); the recipient identifies the
  // patient inside EYELOG after logging in, so no personal data travels by mail.
  // `||` (not `??`) so an empty APP_BASE_URL="" falls back too; strip any
  // trailing slash to avoid a double slash in the link.
  const baseUrl = (process.env.APP_BASE_URL || "https://myopiamanage.org").replace(
    /\/+$/,
    "",
  );
  const chartUrl = `${baseUrl}/chart/${alert.patientId}`;
  const html = `
    <p>${alert.title}</p>
    <p>확인이 필요한 측정값이 입력되었습니다.</p>
    <ul>
      <li>측정일: ${measuredDate}</li>
    </ul>
    <p>아래 항목을 확인해주세요.</p>
    <ul>
      ${alert.reasons.map((r) => `<li>${r}</li>`).join("\n      ")}
    </ul>
    <p>환자 정보는 아래 링크에서 로그인 후 확인해주세요.</p>
    <p><a href="${chartUrl}">▶ EYELOG에서 환자 기록 확인하기</a></p>
    <p style="color:#888;font-size:12px;">본 메일에는 개인정보 보호를 위해 환자 식별정보(등록번호 등)가 포함되어 있지 않습니다.</p>
  `;

  await sendEmail(recipients, `[EYELOG] ${alert.title}`, html);
}
