import prisma from "../lib/prisma";
import { decryptSymmetric } from "../services/encrpytion";

export async function deduplicatePatient() {
  const patients = await prisma.patient.findMany({
    include: {
      measurement: true,
      hospital: true,
    },
  });
  const patientsWithRegistrationNumber = await Promise.all(
    patients.map(async (patient) => ({
      ...patient,
      registrationNumber: await decryptSymmetric(
        patient.encrypted_registration_number,
      ),
    })),
  );
  const map = new Map<
    string,
    (typeof patientsWithRegistrationNumber)[number][]
  >();
  patientsWithRegistrationNumber.forEach((patient) => {
    const key = `${patient.hospital.id}/${patient.registrationNumber}`;
    map.set(key, [...(map.get(key) ?? []), patient]);
  });
  map.forEach(async (patients, key) => {
    if (patients.length > 1) {
      const patientToKeep = patients.sort(
        (a, b) => b.measurement.length - a.measurement.length,
      )[0];
      const patientsToDelete = patients.filter(
        (patient) => patient.id !== patientToKeep.id,
      );
      await prisma.patient.deleteMany({
        where: {
          id: {
            in: patientsToDelete.map((patient) => patient.id),
          },
        },
      });
      console.log(`Deleted ${patientsToDelete.length} patients for ${key}`);
    }
  });
}

deduplicatePatient();
