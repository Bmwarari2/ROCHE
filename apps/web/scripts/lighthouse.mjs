#!/usr/bin/env node
// Lighthouse CI for the web tier (lighthouserc.cjs): collects signed-out pages, signs in as the
// demo manager through the web app's own /api/auth, collects signed-in pages with that session,
// then asserts the budgets over every run and writes the reports to .lighthouseci/reports.
// Needs a production build (`next start`), the API and the seeded demo database, with
// HARBOUR_DEMO_MFA=off so a password alone opens care records (local and CI databases only).
// Chrome: CHROME_PATH, or whatever chrome-launcher finds.
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";

const WEB_URL = process.env.WEB_URL ?? "http://localhost:3000";
const EMAIL = process.env.HARBOUR_LHCI_EMAIL ?? "manager@example.invalid";
const PASSWORD = process.env.HARBOUR_DEMO_PASSWORD ?? "correct horse battery staple";
const CONFIG = "--config=lighthouserc.cjs";

function lhci(args, extraEnv = {}) {
  const result = spawnSync("lhci", [...args, CONFIG], {
    stdio: "inherit",
    env: { ...process.env, ...extraEnv },
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

/** Signs in with the password and returns the cookies the web app set, as a Cookie header. */
async function signIn() {
  const response = await fetch(`${WEB_URL}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: WEB_URL },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    redirect: "manual",
  });
  const cookies = response.headers.getSetCookie().map((line) => line.split(";")[0]);
  if (!response.ok || cookies.length === 0) {
    throw new Error(
      `Signing in for the signed-in pages failed (HTTP ${response.status}): is the demo seed in place with HARBOUR_DEMO_MFA=off?`,
    );
  }
  return cookies.join("; ");
}

rmSync(".lighthouseci", { recursive: true, force: true });
if (lhci(["collect"]) !== 0) process.exit(1);
const cookie = await signIn();
// --additive keeps the signed-out runs: collect otherwise starts afresh.
if (lhci(["collect", "--additive"], { HARBOUR_LHCI_COOKIE: cookie }) !== 0) process.exit(1);
const asserted = lhci(["assert"]);
lhci(["upload"]);
process.exit(asserted);
