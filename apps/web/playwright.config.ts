import { defineConfig, devices } from "@playwright/test";

/**
 * Web journeys with axe (WCAG 2.2 AA). Starts the API (built: apps/api/dist) and the web app
 * (built: next build) unless they are already running locally. The database must hold the demo
 * tenant: `pnpm --filter @harbour/db migrate && pnpm --filter @harbour/db seed &&
 * HARBOUR_SEED_DEMO_USERS=1 HARBOUR_DEMO_MFA=off HARBOUR_DEMO_E2E_PASSKEY=1 pnpm --filter
 * @harbour/api seed:users` (the last gives the demo manager the passkey the step-up journeys use).
 */
const WEB_URL = process.env.WEB_URL ?? "http://localhost:3000";
const API_URL = process.env.API_URL ?? "http://localhost:4000";
const CI = Boolean(process.env.CI);

export default defineConfig({
  testDir: "./e2e",
  // The journeys sign in as demo users; Better Auth throttles sign-ins, so run them one at a time.
  fullyParallel: false,
  workers: 1,
  forbidOnly: CI,
  retries: CI ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: CI ? [["list"], ["html", { open: "never" }]] : [["list"]],
  use: {
    baseURL: WEB_URL,
    locale: "en-GB",
    timezoneId: "Europe/London",
    trace: "retain-on-failure",
    screenshot: "off",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: "node dist/server.js",
      cwd: "../api",
      url: `${API_URL}/health`,
      // Every journey signs in from one address here; the production limit (10) would refuse them.
      env: { AUTH_SIGN_IN_PER_MINUTE: "600" },
      reuseExistingServer: !CI,
      timeout: 60_000,
      stdout: "ignore",
      stderr: "pipe",
    },
    {
      command: "pnpm start",
      url: `${WEB_URL}/api/health`,
      reuseExistingServer: !CI,
      timeout: 120_000,
      // The e-learning content origin: the same server under another host name (ADR-0093).
      env: {
        API_URL,
        PUBLIC_WEB_URL: WEB_URL,
        ELEARNING_ORIGIN: process.env.ELEARNING_ORIGIN ?? "http://127.0.0.1:3000",
        NEXT_TELEMETRY_DISABLED: "1",
      },
      stdout: "ignore",
      stderr: "pipe",
    },
  ],
});
