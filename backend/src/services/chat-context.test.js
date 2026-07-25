// Unit tests for chat-context token estimation. Run with: node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import { estimateTokens } from "./chat-context.js";

test("estimateTokens grows with content length", () => {
  const small = estimateTokens([{ role: "user", content: "hi" }]);
  const big = estimateTokens([{ role: "user", content: "x".repeat(4000) }]);
  assert.ok(big > small);
  // ~4 chars/token + overhead → 4000 chars ≈ 1000+ tokens
  assert.ok(big >= 1000);
});

test("estimateTokens sums across messages and tolerates empty content", () => {
  const total = estimateTokens([
    { role: "system", content: "a".repeat(40) }, // ~10 + 4
    { role: "user", content: "" }, // 0 + 4
    { role: "assistant", content: "b".repeat(40) }, // ~10 + 4
  ]);
  assert.equal(total, 10 + 4 + 0 + 4 + 10 + 4);
});

test("estimateTokens of an empty list is 0", () => {
  assert.equal(estimateTokens([]), 0);
});
