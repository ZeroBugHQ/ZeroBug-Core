// Cross-platform runner for the real-browser integration tests. Sets
// RUN_INTEGRATION=1 (so the *.integration.test.js files actually run instead of
// self-skipping) and invokes node's test runner on just those files. Dep-free —
// avoids needing cross-env for the env var across cmd/PowerShell/sh.
import { spawnSync } from "node:child_process";

const result = spawnSync(
  process.execPath,
  ["--test", "src/**/*.integration.test.js"],
  { stdio: "inherit", env: { ...process.env, RUN_INTEGRATION: "1" } },
);

process.exit(result.status ?? 1);
