import prisma from "../lib/prisma";
import { encryptSymmetric } from "../services/encrpytion";

export async function encryptPatientData() {
  const toEncrypt = await prisma.patient.findMany({
    select: {
      id: true,
      registration_number: true,
      date_of_birth: true,
    },
    where: {
      encrypted_date_of_birth: null,
      encrypted_registration_number: null,
    },
  });

  for (const patient of toEncrypt) {
    const [encryptedRegistrationNumber, encryptedDateOfBirth] =
      await Promise.all([
        encryptSymmetric(patient.registration_number!),
        encryptSymmetric(patient.date_of_birth!.toISOString().split("T")[0]),
      ]);
    await prisma.patient
      .update({
        where: { id: patient.id },
        data: {
          encrypted_registration_number: Uint8Array.from(
            encryptedRegistrationNumber,
          ),
          encrypted_date_of_birth: Uint8Array.from(encryptedDateOfBirth),
        },
      })
      .then(() => {
        console.log(`Encrypted patient ${patient.id}`);
      })
      .catch((error) => {
        console.error(`Error encrypting patient ${patient.id}: ${error}`);
      });
  }
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

encryptPatientData().then(deletePlaintextPatientData).catch(console.error);
