import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts", "src/**/*.test.ts"],
    // Each file creates and migrates its own database.
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
