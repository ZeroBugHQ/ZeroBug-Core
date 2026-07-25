// Unit tests for dependency ordering/skip. Run with: node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import { orderByDependencies, dependenciesMet } from "./queue-deps.js";

const mk = (code, deps = []) => ({ code, dependsOn: deps });

test("a dependency is ordered before its dependent", () => {
  const ordered = orderByDependencies([mk("B", ["A"]), mk("A")]);
  assert.deepEqual(
    ordered.map((t) => t.code),
    ["A", "B"],
  );
});

test("chains resolve transitively", () => {
  const ordered = orderByDependencies([mk("C", ["B"]), mk("B", ["A"]), mk("A")]);
  assert.deepEqual(
    ordered.map((t) => t.code),
    ["A", "B", "C"],
  );
});

test("independent tests keep their original relative order", () => {
  const ordered = orderByDependencies([mk("X"), mk("Y"), mk("Z")]);
  assert.deepEqual(
    ordered.map((t) => t.code),
    ["X", "Y", "Z"],
  );
});

test("cycles do not hang and include every test once", () => {
  const ordered = orderByDependencies([mk("A", ["B"]), mk("B", ["A"])]);
  assert.equal(ordered.length, 2);
  assert.deepEqual([...new Set(ordered.map((t) => t.code))].sort(), ["A", "B"]);
});

test("unknown dependency codes are ignored in ordering", () => {
  const ordered = orderByDependencies([mk("A", ["GHOST"])]);
  assert.deepEqual(
    ordered.map((t) => t.code),
    ["A"],
  );
});

test("dependenciesMet: blocks until a known dep has passed", () => {
  const known = new Set(["A", "B"]);
  const t = mk("B", ["A"]);
  assert.equal(dependenciesMet(t, new Set(), known), false);
  assert.equal(dependenciesMet(t, new Set(["A"]), known), true);
});

test("dependenciesMet: unknown deps are ignored", () => {
  const known = new Set(["B"]);
  assert.equal(dependenciesMet(mk("B", ["GHOST"]), new Set(), known), true);
});
