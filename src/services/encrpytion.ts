import { KeyManagementServiceClient } from "@google-cloud/kms";

import crc32c from "fast-crc32c";

const client = new KeyManagementServiceClient();

const projectId = process.env.GOOGLE_CLOUD_PROJECT_ID;
const locationId = process.env.GOOGLE_CLOUD_LOCATION_ID;
const keyRingId = process.env.GOOGLE_CLOUD_KEY_RING_ID;
const cryptoKeyId = process.env.GOOGLE_CLOUD_CRYPTO_KEY_ID;

if (!projectId || !locationId || !keyRingId || !cryptoKeyId) {
  throw new Error("Missing environment variables");
}
const keyName = client.cryptoKeyPath(
  projectId,
  locationId,
  keyRingId,
  cryptoKeyId,
);

export async function encryptSymmetric(
  plainText: string | Buffer | Uint8Array,
): Promise<Uint8Array> {
  const plainTextBuffer = Buffer.from(plainText);
  const plaintextCrc32c = crc32c.calculate(plainTextBuffer);

  const [encryptResponse] = await client.encrypt({
    name: keyName,
    plaintext: plainTextBuffer,
    plaintextCrc32c: {
      value: plaintextCrc32c,
    },
  });

  const ciphertext = encryptResponse.ciphertext as Buffer;

  // Optional, but recommended: perform integrity verification on encryptResponse.
  // For more details on ensuring E2E in-transit integrity to and from Cloud KMS visit:
  // https://cloud.google.com/kms/docs/data-integrity-guidelines
  if (!encryptResponse.verifiedPlaintextCrc32c) {
    throw new Error("Encrypt: request corrupted in-transit");
  }
  if (
    crc32c.calculate(ciphertext) !==
    Number(encryptResponse.ciphertextCrc32c?.value)
  ) {
    throw new Error("Encrypt: response corrupted in-transit");
  }

  return Uint8Array.from(ciphertext);
}

export async function decryptSymmetric(
  ciphertext: Uint8Array | Buffer | string,
): Promise<string> {
  const ciphertextBuffer = Buffer.from(ciphertext);
  const ciphertextCrc32c = crc32c.calculate(ciphertextBuffer);

  const [decryptResponse] = await client.decrypt({
    name: keyName,
    ciphertext: ciphertextBuffer,
    ciphertextCrc32c: {
      value: ciphertextCrc32c,
    },
  });

  const plaintext = decryptResponse.plaintext as Buffer;

  // Optional, but recommended: perform integrity verification on decryptResponse.
  // For more details on ensuring E2E in-transit integrity to and from Cloud KMS visit:
  // https://cloud.google.com/kms/docs/data-integrity-guidelines
  if (
    crc32c.calculate(plaintext) !==
    Number(decryptResponse.plaintextCrc32c?.value)
  ) {
    throw new Error("Decrypt: response corrupted in-transit");
  }

  return plaintext.toString("utf-8");
}
