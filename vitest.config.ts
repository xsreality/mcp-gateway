import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Unit tests import from src/; e2e tests spawn the built dist/cli.js
    // (see test/global-setup.ts, which runs the build once before any test).
    include: ["test/**/*.test.ts"],
    globalSetup: ["test/global-setup.ts"],
    // The e2e tests each spawn a CLI subprocess + a mock server and talk
    // real JSON-RPC over a pipe; give them headroom over the default 5s.
    testTimeout: 20_000,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      reporter: ["text", "html"],
      // NOTE: the e2e tests spawn the *built* gateway as a subprocess, so v8
      // only instruments code that runs in-process. Coverage numbers therefore
      // reflect the unit-tested modules (config/canonical/store); the relay,
      // provider, callback and CLI entrypoint are exercised functionally by the
      // e2e suite but won't show up as covered lines here.
    },
  },
});
