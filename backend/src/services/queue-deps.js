// Pure helpers for test ordering by dependency. Tests declare `dependsOn` as a
// list of test CODES that must pass first. Used by the queue runner.

/**
 * Order tests so each test's (in-set) dependencies come before it. Stable for
 * independent tests; cycles are broken gracefully (no infinite loop).
 */
export function orderByDependencies(tests) {
  const byCode = new Map(tests.map((t) => [t.code, t]));
  const visited = new Set();
  const inProgress = new Set();
  const result = [];

  function visit(test) {
    if (visited.has(test.code) || inProgress.has(test.code)) return;
    inProgress.add(test.code);
    for (const depCode of test.dependsOn ?? []) {
      const dep = byCode.get(depCode);
      if (dep) visit(dep);
    }
    inProgress.delete(test.code);
    visited.add(test.code);
    result.push(test);
  }

  for (const test of tests) visit(test);
  return result;
}

/**
 * True if every dependency that exists in the run set has already passed.
 * Dependencies on codes not present in `knownCodes` are ignored (a typo or a
 * test outside this run shouldn't permanently block).
 */
export function dependenciesMet(test, passedCodes, knownCodes) {
  for (const depCode of test.dependsOn ?? []) {
    if (knownCodes && !knownCodes.has(depCode)) continue;
    if (!passedCodes.has(depCode)) return false;
  }
  return true;
}
