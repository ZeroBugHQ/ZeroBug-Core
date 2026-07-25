import { Secret } from "../models/secret.model.js";
import { encryptSecret, decryptSecret } from "./crypto-service.js";

// Secret keys are referenced in tests as {{KEY}}, so keep them identifier-safe.
const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function normalizeSecretKey(raw) {
  return String(raw ?? "").trim();
}
export function isValidSecretKey(key) {
  return KEY_RE.test(key);
}

export async function setSecret(environmentId, key, value) {
  const k = normalizeSecretKey(key);
  if (!isValidSecretKey(k)) {
    throw new Error("Secret key must start with a letter/underscore and contain only A-Z, 0-9, _");
  }
  await Secret.findOneAndUpdate(
    { environmentId, key: k },
    { valueEnc: encryptSecret(value ?? "") },
    { upsert: true, new: true },
  );
  return k;
}

/** Keys + metadata only — never plaintext values. */
export async function listSecretKeys(environmentId) {
  const secrets = await Secret.find({ environmentId }).sort({ key: 1 }).lean();
  return secrets.map((s) => ({ key: s.key, updatedAt: s.updatedAt }));
}

export async function deleteSecret(environmentId, key) {
  await Secret.deleteOne({ environmentId, key: normalizeSecretKey(key) });
}

export async function deleteSecretsForEnvironment(environmentId) {
  await Secret.deleteMany({ environmentId });
}

/** Decrypted { KEY: value } map for injecting into a run (server-side only). */
export async function getSecretMap(environmentId) {
  if (!environmentId) return {};
  const secrets = await Secret.find({ environmentId }).lean();
  const map = {};
  for (const s of secrets) {
    try {
      map[s.key] = decryptSecret(s.valueEnc);
    } catch {
      // Skip values that can't be decrypted (e.g. the encryption key changed).
    }
  }
  return map;
}
