import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    environment: "node",
    // Component tests (.tsx) choose jsdom per file with a `@vitest-environment` comment.
    include: ["src/**/*.test.{ts,tsx}"],
    passWithNoTests: false,
  },
});
