import { expect, type Page, test } from "@playwright/test";
import { expectAccessible } from "./support";

/**
 * The invitation link's page (PLAT-004; H-355). The token is only ever emailed, so the states a
 * real invitation reaches (the create-sign-in form, expired, withdrawn, used, throttled) are drawn
 * by answering the page's own route handlers (/api/invitations/*) with `page.route`; a link
 * without its token and an unknown link go through the real API. Each state is checked with axe,
 * focus lands on its heading, and the token is never in a URL a server sees.
 */

// Well formed (43 base64url characters) but never issued.
const UNKNOWN = "Zz0Example0Invitation0Token0Never0Issued000";

const FOUND = {
  kind: "found",
  organisationName: "Example Care Homes",
  emailMasked: "a…@example.invalid",
  expiresAt: "19/10/2026 10:00",
  path: "create_sign_in",
};

/** Answers the lookup (and optionally the accept) with the given results. */
async function answer(page: Page, lookup: object, accept?: object) {
  await page.route("**/api/invitations/lookup", (route) => route.fulfill({ json: lookup }));
  if (accept) {
    await page.route("**/api/invitations/accept", (route) => route.fulfill({ json: accept }));
  }
}

const heading = (page: Page, name: string) =>
  page.getByRole("main").getByRole("heading", { level: 2, name });

test("a link without its token says so plainly", async ({ page }) => {
  const response = await page.goto("/invitation");
  expect(response?.headers()["referrer-policy"]).toBe("no-referrer");
  await expect(
    page.getByRole("heading", { level: 1, name: "Accept your invitation" }),
  ).toBeVisible();
  await expect(heading(page, "This invitation cannot be used")).toBeFocused();
  await expect(page.getByRole("main")).toContainText("This link is not complete");
  await expectAccessible(page, "invitation without a token");
});

test("an unknown link says so, and its token never appears in a URL", async ({ page }) => {
  expect(UNKNOWN).toMatch(/^[A-Za-z0-9_-]{43}$/);
  const urls: string[] = [];
  page.on("request", (request) => {
    // What reaches a server: the path and query string (a fragment never leaves the browser).
    const { pathname, search } = new URL(request.url());
    urls.push(`${pathname}${search}`);
  });

  await page.goto(`/invitation#${UNKNOWN}`);
  await expect(heading(page, "This invitation cannot be used")).toBeFocused();
  await expect(page.getByRole("main")).toContainText("This link does not work");

  // Out of the address bar once read, and never sent in a path or query string.
  expect(new URL(page.url()).hash).toBe("");
  expect(urls.filter((url) => url.includes(UNKNOWN))).toEqual([]);
  await expectAccessible(page, "unknown invitation");
});

test("the create-sign-in form: rules up front, show or hide, and an error summary", async ({
  page,
}) => {
  await answer(page, FOUND, { kind: "invalid", password: "common" });
  await page.goto(`/invitation#${UNKNOWN}`);
  const main = page.getByRole("main");

  await expect(heading(page, "Join Example Care Homes on Harbour")).toBeFocused();
  await expect(main).toContainText("Use at least 12 characters.");
  await expectAccessible(page, "create sign-in form");

  // Nothing entered: the summary takes focus and links to each field.
  await main.getByRole("button", { name: "Create sign-in" }).click();
  const summary = main.getByRole("alert");
  await expect(summary).toBeFocused();
  await expect(summary.getByRole("link", { name: "Enter your name" })).toBeVisible();
  await expect(summary.getByRole("link", { name: "Enter a password" })).toBeVisible();
  await expect(main.getByLabel("Your name")).toHaveAttribute("aria-invalid", "true");
  await expectAccessible(page, "create sign-in form with errors");

  // Show and hide the password.
  const password = main.getByLabel("Create a password");
  await password.fill("Password1234");
  await expect(password).toHaveAttribute("type", "password");
  await main.getByRole("button", { name: "Show password" }).click();
  await expect(password).toHaveAttribute("type", "text");
  await expect(main.getByRole("status").filter({ hasText: "Your password is shown" })).toHaveCount(
    1,
  );
  await main.getByRole("button", { name: "Hide password" }).click();
  await expect(password).toHaveAttribute("type", "password");

  // A common password is refused at the field, in the API's words.
  await main.getByLabel("Your name").fill("Ada Example");
  await password.fill("correct horse battery staple");
  await main.getByRole("button", { name: "Create sign-in" }).click();
  await expect(main.getByRole("alert")).toBeFocused();
  await expect(main.getByRole("alert")).toContainText(
    "That password is too common. Try three random words.",
  );
  await expectAccessible(page, "create sign-in form refused");
});

test("a new sign-in is told to sign in next", async ({ page }) => {
  await answer(page, FOUND, {
    kind: "accepted",
    next: "sign_in",
    destination: "/sign-in?next=%2Fsettings%2Fsecurity%3Freason%3Dmfa",
  });
  await page.goto(`/invitation#${UNKNOWN}`);
  const main = page.getByRole("main");
  await main.getByLabel("Your name").fill("Ada Example");
  await main.getByLabel("Create a password").fill("correct horse battery staple");
  await main.getByRole("button", { name: "Create sign-in" }).click();
  await expect(heading(page, "Your sign-in is ready")).toBeFocused();
  await expect(main.getByRole("link", { name: "Sign in" })).toHaveAttribute(
    "href",
    "/sign-in?next=%2Fsettings%2Fsecurity%3Freason%3Dmfa",
  );
  await expectAccessible(page, "sign-in ready");
});

test("a sign-in that already exists is asked to sign in first", async ({ page }) => {
  await answer(page, { ...FOUND, path: "sign_in_first" });
  await page.goto(`/invitation#${UNKNOWN}`);
  await expect(heading(page, "Join Example Care Homes on Harbour")).toBeFocused();
  await expect(heading(page, "Sign in first")).toBeVisible();
  await expect(page.getByRole("main").getByRole("link", { name: "Sign in" })).toHaveAttribute(
    "href",
    "/sign-in?next=%2Finvitation",
  );
  await expectAccessible(page, "sign in first");
});

for (const [refusal, words] of [
  ["invitation_expired", "This invitation has expired."],
  ["invitation_revoked", "This invitation was withdrawn."],
  ["invitation_used", "This invitation has already been used."],
] as const) {
  test(`${refusal} is said in plain words`, async ({ page }) => {
    await answer(page, { kind: "refused", refusal });
    await page.goto(`/invitation#${UNKNOWN}`);
    await expect(heading(page, "This invitation cannot be used")).toBeFocused();
    await expect(page.getByRole("main")).toContainText(words);
    await expectAccessible(page, refusal);
  });
}

test("too many attempts says how long to wait", async ({ page }) => {
  await answer(page, { kind: "throttled", minutes: 2 });
  await page.goto(`/invitation#${UNKNOWN}`);
  await expect(heading(page, "Too many attempts")).toBeFocused();
  await expect(page.getByRole("main")).toContainText("Wait 2 minutes, then try again.");
  await expect(page.getByRole("main").getByRole("button", { name: "Try again" })).toBeVisible();
  await expectAccessible(page, "throttled");
});
