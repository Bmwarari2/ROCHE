import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Only pure modules are unit-tested here (no React Native runtime); screens are covered by
    // typecheck and the Maestro flows in .maestro/.
    include: ["src/**/*.test.ts"],
    passWithNoTests: false,
    env: { TZ: "Europe/London" },
  },
});
