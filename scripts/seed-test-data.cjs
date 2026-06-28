/**
 * Test data seeder (no KMS required).
 *
 * Assumes `POST /auth/dev_login` has already run, so the "Dev Hospital" and the
 * admin "devuser" exist. This script:
 *   1. creates a test ethnicity + instrument,
 *   2. creates a test patient in Dev Hospital (dummy encrypted fields),
 *   3. turns on email alerts for the dev user (email + receive_email_updates),
 * then prints PATIENT_ID / INSTRUMENT_ID for the shell to capture.
 */
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

async function main() {
  // Safety: never seed test data into a production database.
  if (process.env.NODE_ENV === "production") {
    throw new Error("Refusing to run test seeder with NODE_ENV=production.");
  }

  const hospital = await prisma.hospital.findFirst({
    where: { name: "Dev Hospital" },
  });
  if (!hospital) {
    throw new Error("Dev Hospital not found — run POST /auth/dev_login first.");
  }

  const ethnicity = await prisma.ethnicity.upsert({
    where: { name: "TestEthnicity" },
    update: {},
    create: { name: "TestEthnicity" },
  });

  const instrument = await prisma.instrument.upsert({
    where: { name: "TestInstrument" },
    update: {},
    create: { name: "TestInstrument" },
  });

  // Reuse an existing test patient if present (unique on hash+hospital).
  const hash = "test-reg-hash-001";
  let patient = await prisma.patient.findFirst({
    where: { registration_number_hash: hash, hospital_id: hospital.id },
  });
  if (!patient) {
    patient = await prisma.patient.create({
      data: {
        hospital_id: hospital.id,
        sex: "male",
        ethnicity_id: ethnicity.id,
        registration_number_hash: hash,
        encrypted_registration_number: Buffer.from("dummy-reg-number"),
        encrypted_date_of_birth: Buffer.from("dummy-dob"),
      },
    });
  }

  // Enable email alerts for the dev admin so threshold emails have a recipient.
  const devAuth = await prisma.password_auth.findUnique({
    where: { username: "devuser" },
  });
  if (devAuth) {
    await prisma.user.update({
      where: { id: devAuth.user_id },
      data: { email: "doctor@eyelog.test", receive_email_updates: true },
    });
  }

  // Machine-readable lines for the setup script to grep.
  console.log(`PATIENT_ID=${patient.id}`);
  console.log(`INSTRUMENT_ID=${instrument.id}`);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
