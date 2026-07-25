import { test } from "node:test";
import assert from "node:assert/strict";
import { parseJsonLoose, salvageDecision } from "./ollama.js";

test("parseJsonLoose handles clean JSON", () => {
  assert.deepEqual(parseJsonLoose('{"action":"click","ref":3}'), { action: "click", ref: 3 });
});

test("parseJsonLoose strips prose and code fences around the object", () => {
  const raw = 'Sure! Here is my decision:\n```json\n{"action":"navigate","url":"/x"}\n```\nHope that helps.';
  assert.deepEqual(parseJsonLoose(raw), { action: "navigate", url: "/x" });
});

test("parseJsonLoose fixes smart quotes and trailing commas", () => {
  const raw = '{“action”:“type”,“ref”:5,“text”:“hi”,}';
  assert.deepEqual(parseJsonLoose(raw), { action: "type", ref: 5, text: "hi" });
});

test("parseJsonLoose escapes raw newlines inside strings", () => {
  const raw = '{"thought":"line one\nline two","action":"click","ref":2}';
  const obj = parseJsonLoose(raw);
  assert.equal(obj.action, "click");
  assert.equal(obj.ref, 2);
});

test("parseJsonLoose closes a truncated object", () => {
  const raw = '{"action":"wait","ms":1000';
  assert.deepEqual(parseJsonLoose(raw), { action: "wait", ms: 1000 });
});

test("parseJsonLoose quotes bare keys", () => {
  assert.deepEqual(parseJsonLoose("{action: \"scroll\", direction: \"down\"}"), {
    action: "scroll",
    direction: "down",
  });
});

test("salvageDecision recovers an action from unparseable text", () => {
  const raw = 'I think we should {"action": "click", "ref": 7  <-- broken and truncated';
  const d = salvageDecision(raw);
  assert.equal(d.action, "click");
  assert.equal(d.ref, 7);
});

test("salvageDecision infers action word when no action field", () => {
  const d = salvageDecision("Let's finish now, the task is done. success true");
  assert.equal(d.action, "finish");
});

test("salvageDecision returns null when no known action present", () => {
  assert.equal(salvageDecision("the weather is nice today"), null);
});
