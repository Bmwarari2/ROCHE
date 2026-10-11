import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts", "src/**/*.test.ts"],
    // @powersync/service-sync-rules uses `using` declarations, which Node 22 enables behind a flag.
    pool: "forks",
    execArgv: ["--js-explicit-resource-management"],
  },
});
