// Unit tests for the pending-question broker. Run with: node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  askQuestion,
  answerQuestion,
  cancelQuestion,
  hasPendingQuestion,
} from "./question-broker.js";

test("askQuestion emits a question event carrying a questionId", () => {
  const events = [];
  askQuestion({ question: "Need login?", testCode: "AUTH-01" }, (e) => events.push(e));

  assert.equal(events.length, 1);
  const ev = events[0];
  assert.equal(ev.type, "question");
  assert.equal(ev.question, "Need login?");
  assert.equal(ev.testCode, "AUTH-01");
  assert.equal(typeof ev.questionId, "string");
  assert.ok(ev.questionId.length > 0);
  assert.ok(hasPendingQuestion(ev.questionId));

  // resolve so the timer doesn't linger
  cancelQuestion(ev.questionId);
});

test("answerQuestion resolves the pending promise with the answer text", async () => {
  let captured;
  const promise = askQuestion({ question: "?" }, (e) => (captured = e)).then((a) => a);

  assert.equal(answerQuestion(captured.questionId, "use admin@example.com / hunter2"), true);
  const answer = await promise;
  assert.equal(answer, "use admin@example.com / hunter2");
  assert.equal(hasPendingQuestion(captured.questionId), false);
});

test("answering an unknown id is a harmless no-op", () => {
  assert.equal(answerQuestion("does-not-exist", "hi"), false);
});

test("timeout resolves the promise to null", async () => {
  let captured;
  const promise = askQuestion({ question: "?" }, (e) => (captured = e), { timeoutMs: 20 });
  const answer = await promise;
  assert.equal(answer, null);
  assert.equal(hasPendingQuestion(captured.questionId), false);
});

test("cancelQuestion resolves to null and clears the entry", async () => {
  let captured;
  const promise = askQuestion({ question: "?" }, (e) => (captured = e));
  assert.equal(cancelQuestion(captured.questionId), true);
  assert.equal(await promise, null);
  // second cancel finds nothing
  assert.equal(cancelQuestion(captured.questionId), false);
});
