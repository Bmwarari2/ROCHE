import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";

/**
 * Phase 0 smoke journeys (Brian's acceptance: sign in and see the empty demo home), each page
 * scanned with axe for WCAG 2.2 AA. Demo accounts only: invented people, example.invalid emails.
 */

const PASSWORD = process.env.HARBOUR_DEMO_PASSWORD ?? "correct horse battery staple";
const WCAG_AA = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
const UNKNOWN_PERSON = "/people/00000000-0000-4000-8000-000000000000";

/**
 * Waits for entry animations (a sheet or menu fading in) to finish, so axe measures contrast on
 * what people see once it has settled, not a half-transparent frame. Endless animations, such as
 * a spinner, are skipped.
 */
async function settleAnimations(page: Page) {
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
        .map((animation) => animation.finished.catch(() => undefined)),
    ),
  );
}

async function expectAccessible(page: Page, name: string) {
  await settleAnimations(page);
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

async function signIn(page: Page, email: string) {
  await page.goto("/sign-in");
  await expect(page.getByRole("heading", { level: 1, name: "Sign in to Harbour" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign in with a passkey" })).toBeVisible();
  await expectAccessible(page, "sign-in");
  await page.getByLabel("Email address").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL((url) => url.pathname === "/");
}

async function signOut(page: Page) {
  await page.getByRole("button", { name: /^Your account/ }).click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await page.waitForURL((url) => url.pathname === "/sign-in");
}

test("a manager signs in, sees the dashboard, opens people and a person, and signs out", async ({
  page,
}) => {
  await signIn(page, "manager@example.invalid");

  await expect(page.getByRole("heading", { level: 1, name: "Welcome, Mo Manager" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: "Today" })).toBeVisible();
  await expect(page.getByRole("banner").getByText("Mo Manager")).toBeVisible();
  await expectAccessible(page, "home");

  const modules = page.getByRole("navigation", { name: "Modules" });
  await modules.getByRole("link", { name: "Residents" }).click();
  await page.waitForURL((url) => url.pathname === "/people");
  await expect(page.getByRole("heading", { level: 1, name: "Residents" })).toBeVisible();
  const table = page.getByRole("table", { name: "Residents" });
  await expect(table.getByRole("row", { name: /Addie/ })).toBeVisible();
  // Cara is the seeded resident whose allergies are not recorded; other journeys may add people.
  await expect(
    table.getByRole("row", { name: /Cara Placeholder/ }).getByText("Allergies not recorded"),
  ).toBeVisible();
  await expect(table.getByText("No known allergies").first()).toBeVisible();
  await expectAccessible(page, "people");

  await table.getByRole("link", { name: "Addie" }).click();
  await page.waitForURL(/\/people\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("heading", { level: 1, name: "Addie" })).toBeVisible();
  await expect(page.getByText("Ada Example", { exact: true })).toBeVisible();
  await expect(page.getByText("999 000 0018")).toBeVisible();
  await expect(page.getByText("01/02/1938")).toBeVisible();
  await expect(page.getByText("Penicillin")).toBeVisible();
  await expect(page.getByText("Needs information in large print").first()).toBeVisible();
  await expectAccessible(page, "person");

  await page.goto(UNKNOWN_PERSON);
  await expect(
    page.getByRole("heading", { level: 1, name: "We could not find that." }),
  ).toBeVisible();
  const breakGlass = page.getByRole("button", { name: "Open a record outside your access" });
  await expect(breakGlass).toBeVisible();
  await expectAccessible(page, "person not found");
  await breakGlass.click();
  await expect(
    page.getByRole("dialog", { name: "Open a record outside your access" }),
  ).toBeVisible();
  await expectAccessible(page, "break-glass sheet");
  await page.getByRole("button", { name: "Open record" }).click();
  await expect(page.getByText("characters or more")).toBeVisible();
  await page.keyboard.press("Escape");

  await page.goto("/notifications");
  await expect(page.getByRole("heading", { level: 1, name: "Notifications" })).toBeVisible();
  await expectAccessible(page, "notifications");

  await page.goto("/settings/security");
  await expect(page.getByRole("heading", { level: 2, name: "Authenticator app" })).toBeVisible();
  await expect(page.getByText("This device", { exact: true })).toBeVisible();
  await expectAccessible(page, "security");

  await signOut(page);
  await page.goto("/people");
  await expect(page).toHaveURL(/\/sign-in/);
});

test("a care worker sees exactly the three people assigned to them", async ({ page }) => {
  await signIn(page, "carer@example.invalid");
  await expect(page.getByRole("heading", { level: 1, name: "Welcome, Cat Carer" })).toBeVisible();
  await expectAccessible(page, "carer home");

  await page.goto("/people");
  await expect(page.getByRole("table", { name: "Residents" }).locator("tbody tr")).toHaveCount(3);
  await expectAccessible(page, "carer people");

  // Break-glass is offered only to people who hold people.person.break_glass.
  await page.goto(UNKNOWN_PERSON);
  await expect(
    page.getByRole("heading", { level: 1, name: "We could not find that." }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Open a record outside your access" })).toHaveCount(
    0,
  );

  // On a phone the page does not scroll sideways and the account menu stays reachable.
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto("/people");
  await expect(page.getByRole("table", { name: "Residents" })).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
  const account = page.getByRole("button", { name: /^Your account/ });
  await expect(account).toBeInViewport();
  await expect(account.locator("svg")).toBeVisible();
  await expectAccessible(page, "carer people on a phone");

  await signOut(page);
});

test("an unknown address shows the not-found page", async ({ page }) => {
  await page.goto("/no-such-page");
  await expect(
    page.getByRole("heading", { level: 1, name: "We could not find that." }),
  ).toBeVisible();
  await expectAccessible(page, "not found");
});

test("pages carry a per-request nonce policy and scripts run without violations", async ({
  page,
}) => {
  const violations: string[] = [];
  page.on("console", (message) => {
    if (message.text().includes("Content Security Policy")) violations.push(message.text());
  });
  const first = await page.goto("/sign-in");
  const second = await page.request.get("/sign-in");
  const policy = first?.headers()["content-security-policy"] ?? "";
  expect(policy).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/=]+' 'strict-dynamic'/);
  expect(policy).not.toMatch(/script-src[^;]*'unsafe-inline'/);
  expect(second.headers()["content-security-policy"]).not.toBe(policy);
  // The passkey button is enabled only once the client bundle has hydrated.
  await expect(page.getByRole("button", { name: "Sign in with a passkey" })).toBeEnabled();
  expect(violations).toEqual([]);
});

test("the browser reaches only Better Auth through this origin, never the API's /v1 routes", async ({
  page,
}) => {
  expect((await page.request.get("/v1/me")).status()).toBe(404);
  expect((await page.request.get("/api/auth/get-session")).status()).toBe(200);
});
