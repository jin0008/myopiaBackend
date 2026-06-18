import prisma from "../lib/prisma";
import { AXIAL_LENGTH_ALERT } from "../lib/constants";
import { sendEmail } from "./email";

interface ThresholdMeasurement {
  id: string;
  patient_id: string;
  date: Date;
  od: number | null;
  os: number | null;
}

/**
 * Sends an email alert to the patient hospital's admins when an axial length
 * measurement (od or os) exceeds the configured threshold. Recipients are the
 * hospital's `is_admin` healthcare professionals whose user has opted in via
 * `receive_email_updates`.
 */
export async function checkMeasurementThreshold(
  measurement: ThresholdMeasurement,
): Promise<void> {
  const { od, os } = measurement;
  const exceeded =
    (od != null && od > AXIAL_LENGTH_ALERT.max) ||
    (os != null && os > AXIAL_LENGTH_ALERT.max);
  if (!exceeded) {
    return;
  }

  const patient = await prisma.patient.findUnique({
    where: { id: measurement.patient_id },
    select: { hospital_id: true },
  });
  if (patient == null) {
    return;
  }

  const admins = await prisma.healthcare_professional.findMany({
    where: {
      hospital_id: patient.hospital_id,
      is_admin: true,
      user: { receive_email_updates: true },
    },
    select: { user: { select: { email: true } } },
  });

  const recipients = admins
    .map((admin) => admin.user.email)
    .filter((email): email is string => email != null && email.length > 0);

  if (recipients.length === 0) {
    return;
  }

  const measuredDate = measurement.date.toISOString().slice(0, 10);
  const html = `
    <p>측정값이 임계치를 초과했습니다.</p>
    <ul>
      <li>측정 ID: ${measurement.id}</li>
      <li>환자 ID: ${measurement.patient_id}</li>
      <li>측정일: ${measuredDate}</li>
      <li>OD: ${od ?? "-"} mm</li>
      <li>OS: ${os ?? "-"} mm</li>
      <li>임계값(max): ${AXIAL_LENGTH_ALERT.max} mm</li>
    </ul>
  `;

  await sendEmail(recipients, "[EYELOG] 측정값 임계 초과 알림", html);
}
