import prisma from "./prisma";

export async function isPatientInHospital(
  patientId: string,
  hospitalId: string,
) {
  const result = await prisma.patient.findUnique({
    where: {
      id: patientId,
    },
    select: {
      hospital_id: true,
    },
  });
  return result?.hospital_id === hospitalId;
}
