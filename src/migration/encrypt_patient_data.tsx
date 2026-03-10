import prisma from "../lib/prisma";
import { encryptSymmetric } from "../services/encrpytion";

export async function encryptPatientData() {
  await prisma.patient
    .findMany({
      select: {
        id: true,
        registration_number: true,
        date_of_birth: true,
      },
    })
    .then((patients) => {
      return Promise.all(
        patients.map(async (patient) => {
          const encryptedRegistrationNumber = patient.registration_number
            ? await encryptSymmetric(patient.registration_number)
            : undefined;
          const encryptedDateOfBirth = patient.date_of_birth
            ? await encryptSymmetric(
                patient.date_of_birth.toISOString().split("T")[0],
              )
            : undefined;
          return {
            ...patient,
            encrypted_registration_number: encryptedRegistrationNumber,
            encrypted_date_of_birth: encryptedDateOfBirth,
          };
        }),
      );
    })
    .then((data) => {
      return prisma.$transaction(
        data.map((patient) => {
          return prisma.patient.update({
            where: { id: patient.id },
            data: {
              encrypted_registration_number:
                patient.encrypted_registration_number,
              encrypted_date_of_birth: patient.encrypted_date_of_birth,
            },
          });
        }),
      );
    })
    .then(() => {
      console.log("Patient data encrypted successfully");
    })
    .catch((error) => {
      console.error("Error encrypting patient data:", error);
    });
}

export async function deletePlaintextPatientData() {
  await prisma.patient.updateMany({
    data: {
      registration_number: null,
      date_of_birth: null,
    },
    where: {
      encrypted_date_of_birth: {
        not: null,
      },
      encrypted_registration_number: {
        not: null,
      },
    },
  });
  const plainTextCount = await prisma.patient.count({
    where: {
      OR: [
        {
          registration_number: {
            not: null,
          },
        },
        {
          date_of_birth: {
            not: null,
          },
        },
      ],
    },
  });
  console.log(`${plainTextCount} plaintext patient data left in the database`);
}
