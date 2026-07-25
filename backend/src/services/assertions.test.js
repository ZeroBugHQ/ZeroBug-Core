import { test } from "node:test";
import assert from "node:assert/strict";
import { isAssertionStep, verifyAssertions } from "./playwright-runner.js";

test("isAssertionStep recognises assertions, ignores actions", () => {
  assert.equal(isAssertionStep("Assert toast 'Saved'"), true);
  assert.equal(isAssertionStep("Expect the URL to contain /dashboard"), true);
  assert.equal(isAssertionStep("Verify the welcome banner is visible"), true);
  assert.equal(isAssertionStep("The error message is displayed"), true);
  // Actions are not assertions (so their quoted values aren't mis-checked).
  assert.equal(isAssertionStep("Type 'admin@example.com' into email"), false);
  assert.equal(isAssertionStep("Click the Sign in button"), false);
  assert.equal(isAssertionStep("Open /login"), false);
});

test("verifyAssertions passes when quoted text was seen during the run", () => {
  const results = verifyAssertions({
    steps: ["Open /forgot", "Type 'x@y.com'", "Assert toast 'Check your inbox'"],
    seenText: "Password reset — Check your inbox for a link",
    seenUrls: ["https://app/forgot"],
    finalUrl: "https://app/forgot",
  });
  assert.equal(results.length, 1); // only the assertion step is checked
  assert.equal(results[0].ok, true);
});

test("verifyAssertions matches across cosmetic punctuation/spacing differences", () => {
  // Asserting "Presales" should pass when the page renders "Pre-Sales".
  const results = verifyAssertions({
    steps: ["Verify the dashboard displays the header 'Presales'"],
    seenText: "Pre-Sales — Leads, deal pipeline, mapping, and reporting",
    seenUrls: [],
    finalUrl: "",
  });
  assert.equal(results.length, 1);
  assert.equal(results[0].ok, true);
});

test("verifyAssertions fails when expected text never appeared", () => {
  const results = verifyAssertions({
    steps: ["Assert the page shows 'Welcome back'"],
    seenText: "Invalid email or password",
    seenUrls: ["https://app/login"],
    finalUrl: "https://app/login",
  });
  assert.equal(results.length, 1);
  assert.equal(results[0].ok, false);
});

test("verifyAssertions checks URL assertions against any URL visited", () => {
  const pass = verifyAssertions({
    steps: ["Expect to be redirected to /dashboard"],
    seenText: "",
    seenUrls: ["https://app/login", "https://app/dashboard"],
    finalUrl: "https://app/dashboard",
  });
  assert.equal(pass[0].ok, true);

  const fail = verifyAssertions({
    steps: ["Expect the url to contain /settings"],
    seenText: "",
    seenUrls: ["https://app/login"],
    finalUrl: "https://app/login",
  });
  assert.equal(fail[0].ok, false);
});

test("verifyAssertions skips steps with no concrete target (no false failures)", () => {
  const results = verifyAssertions({
    steps: ["Assert everything looks correct", "Verify it works"],
    seenText: "anything",
    seenUrls: [],
    finalUrl: "",
  });
  assert.equal(results.length, 0);
});
