import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts", "src/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 120_000,
    pool: "forks",
    // @powersync/service-sync-rules (pulled in through @harbour/sync) uses `using` declarations.
    execArgv: ["--js-explicit-resource-management"],
  },
});
