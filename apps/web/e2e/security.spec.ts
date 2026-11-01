import AxeBuilder from "@axe-core/playwright";
import { type Browser, expect, type Page, test } from "@playwright/test";
import { waitForTitle } from "./support";

/**
 * Sign-in and security journeys for the demo nurse: register a passkey with Chromium's virtual
 * authenticator and sign in with it (Brian's Phase 0 acceptance), start authenticator-app set-up,
 * and sign out another device. Leaves the account as it found it.
 */

const PASSWORD = process.env.HARBOUR_DEMO_PASSWORD ?? "correct horse battery staple";
const EMAIL = "nurse@example.invalid";
const PASSKEY_NAME = "Playwright virtual authenticator";
const WCAG_AA = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

async function expectAccessible(page: Page, name: string) {
  await waitForTitle(page);
  const results = await new AxeBuilder({ page }).withTags(WCAG_AA).analyze();
  const blocking = results.violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map((v) => ({ id: v.id, help: v.help, targets: v.nodes.map((n) => n.target.join(" ")) }));
  expect(blocking, `${name}: serious or critical accessibility violations`).toEqual([]);
}

async function signIn(page: Page) {
  await page.goto("/sign-in");
  await page.getByLabel("Email address").fill(EMAIL);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL((url) => url.pathname === "/");
}

async function newSignedInPage(browser: Browser): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await signIn(page);
  return page;
}

async function removeTestPasskeys(page: Page) {
  const list = await page.request.get("/api/auth/passkey/list-user-passkeys");
  if (!list.ok()) return;
  const passkeys = (await list.json()) as { id: string; name?: string | null }[];
  for (const passkey of passkeys.filter((p) => p.name === PASSKEY_NAME)) {
    await page.request.post("/api/auth/passkey/delete-passkey", {
      data: { id: passkey.id },
      headers: { origin: new URL(page.url()).origin },
    });
  }
}

test("a nurse adds a passkey and signs in with it", async ({ page, context }) => {
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });

  await signIn(page);
  await page.goto("/settings/security");
  await page.getByLabel("Name this passkey (optional)").fill(PASSKEY_NAME);
  await page.getByRole("button", { name: "Add a passkey" }).click();
  await expect(page.getByText("Passkey added")).toBeVisible();
  await expect(page.getByText(PASSKEY_NAME)).toBeVisible();

  try {
    await page.getByRole("button", { name: /^Your account/ }).click();
    await page.getByRole("menuitem", { name: "Sign out" }).click();
    await page.waitForURL((url) => url.pathname === "/sign-in");

    await page.getByRole("button", { name: "Sign in with a passkey" }).click();
    await page.waitForURL((url) => url.pathname === "/");
    await expect(
      page.getByRole("heading", { level: 1, name: "Welcome, Nell Nurse" }),
    ).toBeVisible();
  } finally {
    await removeTestPasskeys(page);
  }
});

test("a nurse starts setting up an authenticator app and sees the QR code", async ({ page }) => {
  await signIn(page);
  await page.goto("/settings/security");
  await page.getByLabel("Your password").fill(PASSWORD);
  await page.getByRole("button", { name: "Set up an authenticator app" }).click();
  // Two-factor is switched on only after a code is verified, so the account is unchanged.
  await expect(
    page.getByRole("img", { name: "QR code to add Harbour to your authenticator app" }),
  ).toBeVisible();
  await expect(page.getByText("Keep these backup codes somewhere safe")).toBeVisible();
  await expectAccessible(page, "authenticator set-up");
});

test("a nurse signs out another device", async ({ page, browser }) => {
  const other = await newSignedInPage(browser);
  await signIn(page);
  await page.goto("/settings/security");
  const devices = page.getByRole("button", { name: /^Sign out of this device/ });
  const before = await devices.count();
  expect(before).toBeGreaterThan(0);
  await page.getByRole("button", { name: "Sign out of all other devices" }).click();
  await expect(devices).toHaveCount(0);

  await other.goto("/people");
  await expect(other).toHaveURL(/\/sign-in/);
  await other.context().close();
});
