import { createHash } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import { expect, type Locator, type Page } from "@playwright/test";

/**
 * Shared steps for the care record journeys. Demo accounts only: invented people, example.invalid
 * emails, NHS numbers in the 999 range (master prompt section 20).
 */

export const PASSWORD = process.env.HARBOUR_DEMO_PASSWORD ?? "correct horse battery staple";
const WEB_URL = process.env.WEB_URL ?? "http://localhost:3000";
export const WCAG_AA = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

/**
 * A resident of Harbour Mews, a second home nobody at Harbour House can see (apps/api/scripts/
 * seed-users.ts): opened by break-glass in the journeys.
 */
export const MEWS_PERSON = "0194d000-0000-7000-8600-000000000150";

/** The demo residents' ids from packages/db/src/seed/demo.ts. */
export function demoPerson(n: number): string {
  return `0194d000-0000-7000-8600-${n.toString(16).padStart(12, "0")}`;
}

/**
 * Waits for entry animations (a sheet or menu fading in) to finish, so axe measures contrast on
 * what people see once it has settled, not a half-transparent frame. Endless animations, such as
 * a spinner, are skipped.
 */
export async function settleAnimations(page: Page) {
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
        .map((animation) => animation.finished.catch(() => undefined)),
    ),
  );
}

/** WCAG 2.2 AA with axe: no serious or critical violations. */
export async function expectAccessible(page: Page, name: string) {
  await settleAnimations(page);
  // Axe reads the whole page, but measures a target "obscured" by whatever covers it at the
  // current scroll: from the top, nothing sits under the sticky app bar by accident of where an
  // earlier step scrolled (MOB-013, at 360 px).
  await page.evaluate(() => window.scrollTo(0, 0));
  const results = await new AxeBuilder({ page }).withTags(WCAG_AA).analyze();
  const blocking = results.violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map((v) => ({
      id: v.id,
      impact: v.impact,
      help: v.help,
      targets: v.nodes.map((n) => n.target.join(" ")),
    }));
  expect(blocking, `${name}: serious or critical accessibility violations`).toEqual([]);
}

/** Signs in with the password alone: no second factor, so the session never counts as step-up. */
export async function signIn(page: Page, email: string) {
  await page.goto("/sign-in");
  await page.getByLabel("Email address").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL((url) => url.pathname === "/");
}

/**
 * Gives the page's browser a demo user's passkey (the manager's unless `who` names the owner or the
 * family member), as if it were on their phone: a Chromium virtual authenticator holding the key
 * that apps/api/scripts/seed-users.ts registers with
 * HARBOUR_DEMO_E2E_PASSKEY=1. The key is derived from a published phrase (no secret; the same
 * derivation as the seed). Step-up counts only from a second factor used in the last few minutes
 * (ADR-0072 amendment), so journeys that step up confirm with this, as a person would.
 */
export async function addDemoPasskey(
  page: Page,
  who: "manager" | "owner" | "family" | "starter" = "manager",
) {
  // The manager's labels are the original ones; the others are prefixed (seed-users.ts).
  const digest = (label: string) =>
    createHash("sha256")
      .update(`harbour e2e demo passkey: ${who === "manager" ? label : `${who} ${label}`}`)
      .digest();
  // PKCS#8 for a P-256 private key, the scalar appended (RFC 5915, public key omitted).
  const privateKey = Buffer.concat([
    Buffer.from("3041020100301306072a8648ce3d020106082a8648ce3d030107042730250201010420", "hex"),
    digest("key"),
  ]);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  await cdp.send("WebAuthn.addCredential", {
    authenticatorId,
    credential: {
      credentialId: digest("credential").subarray(0, 16).toString("base64"),
      isResidentCredential: true,
      rpId: process.env.PASSKEY_RP_ID ?? new URL(WEB_URL).hostname,
      privateKey: privateKey.toString("base64"),
      userHandle: Buffer.from(`e2e-demo-${who}`).toString("base64"),
      // The API refuses a signature count that does not go up; each run starts above the last.
      signCount: Math.floor(Date.now() / 1000),
    },
  });
}

/**
 * Signs a demo user (the manager, the owner or the family member) in with their passkey: a session
 * whose step-up is fresh.
 */
export async function signInWithDemoPasskey(
  page: Page,
  who: "manager" | "owner" | "family" | "starter" = "manager",
) {
  await addDemoPasskey(page, who);
  await page.goto("/sign-in");
  await page.getByRole("button", { name: "Sign in with a passkey" }).click();
  await page.waitForURL((url) => url.pathname === "/");
}

/**
 * The module navigation, wherever the screen puts it: the sidebar on a wide screen, or the app
 * bar's "Menu" sheet on a phone (MOB-013), which this opens. Choosing a module closes the sheet;
 * `closeModules` closes it otherwise.
 */
export async function openModules(page: Page): Promise<Locator> {
  const menu = page.getByRole("button", { name: "Menu", exact: true });
  if (await menu.isVisible()) {
    await menu.click();
    return page
      .getByRole("dialog", { name: "Modules" })
      .getByRole("navigation", { name: "Modules" });
  }
  return page.getByRole("navigation", { name: "Modules" });
}

/** Closes the phone's navigation sheet if it is open; nothing on a wide screen. */
export async function closeModules(page: Page) {
  if (await page.getByRole("dialog", { name: "Modules" }).isVisible()) {
    await page.keyboard.press("Escape");
  }
}
