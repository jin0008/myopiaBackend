import prisma from "../lib/prisma";
import { decryptSymmetric } from "../services/encrpytion";
import { hashRegistrationNumber } from "../lib/hash";

const CONCURRENCY = 10;

export async function hashPatientRegistrationNumbers() {
  const toHash = await prisma.patient.findMany({
    select: {
      id: true,
      encrypted_registration_number: true,
    },
  });

  async function processOne(patient: (typeof toHash)[number]) {
    try {
      const registrationNumber = await decryptSymmetric(
        patient.encrypted_registration_number,
      );
      const hash = hashRegistrationNumber(registrationNumber);
      await prisma.patient.update({
        where: { id: patient.id },
        data: { registration_number_hash: hash },
      });
      console.log(`Hashed patient ${patient.id}`);
    } catch (error) {
      console.error(`Error hashing patient ${patient.id}: ${error}`);
    }
  }

  for (let i = 0; i < toHash.length; i += CONCURRENCY) {
    const batch = toHash.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(processOne));
  }
}

hashPatientRegistrationNumbers().catch(console.error);
