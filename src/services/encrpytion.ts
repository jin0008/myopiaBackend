import { KeyManagementServiceClient } from "@google-cloud/kms";

// `fast-crc32c` is a native addon that can crash on import on some
// architectures. It is only needed for the KMS integrity checks, so load it
// lazily — this lets the server boot in environments where encryption is never
// exercised (e.g. local testing) without pulling in the native module.
let crc32cModule: typeof import("fast-crc32c") | null = null;
function crc32c(): typeof import("fast-crc32c") {
  if (crc32cModule == null) {
    crc32cModule = require("fast-crc32c") as typeof import("fast-crc32c");
  }
  return crc32cModule!;
}

const client = new KeyManagementServiceClient();

// Resolve the KMS key path lazily so the server can boot without GOOGLE_CLOUD_*
// env vars (e.g. local testing). The check only fires when encryption is
// actually used.
function getKeyName(): string {
  const projectId = process.env.GOOGLE_CLOUD_PROJECT_ID;
  const locationId = process.env.GOOGLE_CLOUD_LOCATION_ID;
  const keyRingId = process.env.GOOGLE_CLOUD_KEY_RING_ID;
  const cryptoKeyId = process.env.GOOGLE_CLOUD_CRYPTO_KEY_ID;

  if (!projectId || !locationId || !keyRingId || !cryptoKeyId) {
    throw new Error("Missing environment variables");
  }
  return client.cryptoKeyPath(projectId, locationId, keyRingId, cryptoKeyId);
}

export async function encryptSymmetric(
  plainText: string | Buffer | Uint8Array,
): Promise<Uint8Array> {
  const plainTextBuffer = Buffer.from(plainText);
  const plaintextCrc32c = crc32c().calculate(plainTextBuffer);

  const [encryptResponse] = await client.encrypt({
    name: getKeyName(),
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
    crc32c().calculate(ciphertext) !==
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
  const ciphertextCrc32c = crc32c().calculate(ciphertextBuffer);

  const [decryptResponse] = await client.decrypt({
    name: getKeyName(),
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
    crc32c().calculate(plaintext) !==
    Number(decryptResponse.plaintextCrc32c?.value)
  ) {
    throw new Error("Decrypt: response corrupted in-transit");
  }

  return plaintext.toString("utf-8");
}
