import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: {
    // The Material colour library imports without file extensions, which only Vite resolves
    // (m3-scheme-source.ts; ADR-0138).
    server: { deps: { inline: ["@material/material-color-utilities"] } },
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
    setupFiles: ["./src/test/setup.ts"],
    passWithNoTests: false,
    // Rendering every story in two themes with axe takes a few seconds per file.
    testTimeout: 30000,
  },
});
