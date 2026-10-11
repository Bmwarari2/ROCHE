import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Pure logic only: components are covered by typecheck and, later, device tests.
    include: ["src/**/*.test.ts"],
    passWithNoTests: false,
    // Date formatting is checked in UK local time (hazard HZ-008).
    env: { TZ: "Europe/London" },
  },
});
