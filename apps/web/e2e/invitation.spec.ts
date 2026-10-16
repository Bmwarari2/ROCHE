import { expect, test } from "@playwright/test";
import { expectAccessible } from "./support";

/**
 * The invitation link's page (PLAT-004; H-355). The token is only ever emailed, and the journeys
 * cannot read the API's email outbox, so these cover what a link the API does not know and a link
 * without its token do: plain words, focus on the message, the token kept out of every URL the
 * browser requests and out of the address bar, and WCAG 2.2 AA. Creating a sign-in from a real
 * invitation is covered by the API's route tests and the page's unit tests (STATUS follow-up: an
 * e2e hook for the outbox).
 */

// Well formed (43 base64url characters) but never issued.
const UNKNOWN = "Zz0Example0Invitation0Token0Never0Issued000";

test("a link without its token says so plainly", async ({ page }) => {
  const response = await page.goto("/invitation");
  expect(response?.headers()["referrer-policy"]).toBe("no-referrer");
  await expect(
    page.getByRole("heading", { level: 1, name: "Accept your invitation" }),
  ).toBeVisible();
  const message = page.getByRole("alert");
  await expect(message).toContainText("This invitation cannot be used");
  await expect(message).toContainText("This link is not complete");
  await expect(message).toBeFocused();
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
  const message = page.getByRole("alert");
  await expect(message).toContainText("This link does not work");
  await expect(message).toBeFocused();

  // Out of the address bar once read, and never sent in a path or query string.
  expect(new URL(page.url()).hash).toBe("");
  expect(urls.filter((url) => url.includes(UNKNOWN))).toEqual([]);
  await expectAccessible(page, "unknown invitation");
});
