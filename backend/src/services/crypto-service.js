import crypto from "node:crypto";
import { config } from "../config.js";

// AES-256-GCM encryption for secrets at rest. The 32-byte key is derived from
// config.secretsKey (ZEROBUG_SECRETS_KEY) via scrypt.
//
// There is NO fallback key: a predictable default would mean every operator who
// forgot to set the var encrypts their credentials with the same public-source
// key — i.e. no encryption at all. If the key is missing we throw; startup also
// guards against this (see backend/src/server.js) so the app fails loudly instead
// of silently running insecure.
//
// The salt is a fixed KDF salt (NOT a secret). Do not change it — doing so would
// make every previously-encrypted value undecryptable.
const SALT = "pixie-secrets-v1";

export const SECRETS_KEY_ENV = "ZEROBUG_SECRETS_KEY";

/** True when a usable encryption key is configured. */
export function hasSecretsKey() {
  return !!(config.secretsKey && String(config.secretsKey).trim());
}

function getKey() {
  const passphrase = config.secretsKey;
  if (!passphrase || !String(passphrase).trim()) {
    throw new Error(
      `${SECRETS_KEY_ENV} is not set. Refusing to encrypt/decrypt secrets with a ` +
        `default key. Set ${SECRETS_KEY_ENV} to a strong random value ` +
        `(generate one with: openssl rand -base64 32).`,
    );
  }
  return crypto.scryptSync(passphrase, SALT, 32);
}

/** Encrypt a string → "iv:tag:ciphertext" (all base64). */
export function encryptSecret(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", getKey(), iv);
  const enc = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString("base64"), tag.toString("base64"), enc.toString("base64")].join(":");
}

/** Decrypt "iv:tag:ciphertext" → string. Throws if tampered or wrong key. */
export function decryptSecret(payload) {
  const [ivB64, tagB64, dataB64] = String(payload).split(":");
  if (!ivB64 || !tagB64 || !dataB64) throw new Error("Malformed secret payload");
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    getKey(),
    Buffer.from(ivB64, "base64"),
  );
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  const dec = Buffer.concat([
    decipher.update(Buffer.from(dataB64, "base64")),
    decipher.final(),
  ]);
  return dec.toString("utf8");
}
