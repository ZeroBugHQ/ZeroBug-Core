// Unit tests for secret encryption. Run with: node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import { config } from "../config.js";
// There is no default key (see crypto-service.js) — set one for the test. getKey()
// reads config.secretsKey at call time, so mutating it here is sufficient.
config.secretsKey = "test-only-secrets-key-not-for-production";
import { encryptSecret, decryptSecret } from "./crypto-service.js";

test("round-trips a value", () => {
  const secret = "hunter2!@#$%^&*()_+ünîcode";
  const enc = encryptSecret(secret);
  assert.notEqual(enc, secret);
  assert.equal(decryptSecret(enc), secret);
});

test("ciphertext is non-deterministic (random IV)", () => {
  assert.notEqual(encryptSecret("same"), encryptSecret("same"));
});

test("payload has the iv:tag:ciphertext shape", () => {
  const parts = encryptSecret("x").split(":");
  assert.equal(parts.length, 3);
  for (const p of parts) assert.ok(p.length > 0);
});

test("tampered ciphertext fails authentication", () => {
  const enc = encryptSecret("secret");
  const [iv, tag, data] = enc.split(":");
  // flip a byte in the ciphertext
  const buf = Buffer.from(data, "base64");
  buf[0] = buf[0] ^ 0xff;
  const tampered = [iv, tag, buf.toString("base64")].join(":");
  assert.throws(() => decryptSecret(tampered));
});

test("malformed payloads throw", () => {
  assert.throws(() => decryptSecret("not-a-valid-payload"));
});
