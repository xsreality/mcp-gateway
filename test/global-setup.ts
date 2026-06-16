import { execFileSync } from "node:child_process";

/**
 * The e2e tests spawn the *built* gateway (`node dist/cli.js`), so the suite
 * needs a fresh `dist/` before anything runs. Build once here rather than in
 * each test file. Unit tests import from `src/` directly and don't need this,
 * but the build is cheap and runs a single time per `vitest` invocation.
 */
export default function setup() {
  execFileSync("npm", ["run", "build"], { stdio: "inherit" });
}
