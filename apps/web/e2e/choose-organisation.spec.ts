import { expect, type Page, test } from "@playwright/test";
import { demoPerson, expectAccessible, PASSWORD } from "./support";

/**
 * Choosing an organisation (platform: tenancy, ADR-0002). The page is shown only to someone who
 * works for more than one organisation: the end-to-end seed gives Rowan Shared, an invented care
 * coordinator, a membership in the demo organisation (Harbour House) and in Second Example Care
 * (apps/api/scripts/seed-users.ts). The page passes axe in the light and dark themes, and after
 * choosing either organisation the other's residents never appear.
 */

const SHARED = "shared.coordinator@example.invalid";
const DEMO_ORGANISATION = "Harbour Demo Care";
const SECOND_ORGANISATION = "Second Example Care";
/** Bea Elsewhere lives at Second Example House; Addie (Ada Example) at Harbour House. */
const SECOND_RESIDENT = /Bea/;
const DEMO_RESIDENT = /Addie/;
const SECOND_RESIDENT_ID = "0194f100-0000-7000-8600-000000000001";
const NOT_FOUND = "We could not find that.";

const residents = (page: Page) => page.getByRole("table", { name: "Residents" });

/** Signs in with the password; with two organisations the app asks which one first. */
async function signInShared(page: Page) {
  await page.goto("/sign-in");
  await page.getByLabel("Email address").fill(SHARED);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL((url) => url.pathname === "/choose-organisation");
}

async function choose(page: Page, organisation: string) {
  await page.goto("/choose-organisation");
  await page.getByRole("button", { name: organisation }).click();
  await page.waitForURL((url) => url.pathname === "/");
}

test("someone in two organisations chooses one, and sees only its residents", async ({ page }) => {
  test.setTimeout(120_000);
  await signInShared(page);

  await expect(
    page.getByRole("heading", { level: 1, name: "Choose an organisation" }),
  ).toBeVisible();
  const options = page.getByRole("main").getByRole("listitem");
  await expect(options).toHaveCount(2);
  await expect(page.getByRole("button", { name: DEMO_ORGANISATION })).toBeVisible();
  await expect(page.getByRole("button", { name: SECOND_ORGANISATION })).toBeVisible();
  await expectAccessible(page, "choose organisation");
  await page.emulateMedia({ colorScheme: "dark" });
  await expectAccessible(page, "choose organisation, dark theme");
  await page.emulateMedia({ colorScheme: "light" });

  // Second Example Care: its resident, never Harbour House's.
  await choose(page, SECOND_ORGANISATION);
  await page.goto("/people");
  await expect(residents(page).getByRole("row", { name: SECOND_RESIDENT })).toBeVisible();
  await expect(residents(page).locator("tbody tr")).toHaveCount(1);
  await expect(residents(page).getByRole("row", { name: DEMO_RESIDENT })).toHaveCount(0);
  await expectAccessible(page, "residents in the second organisation");
  // Ada Example's record, opened by its address, is not found from here.
  await page.goto(`/people/${demoPerson(1)}`);
  await expect(page.getByRole("heading", { level: 1, name: NOT_FOUND })).toBeVisible();

  // The demo organisation: Harbour House's residents, never Second Example House's.
  await choose(page, DEMO_ORGANISATION);
  await page.goto("/people");
  await expect(residents(page).getByRole("row", { name: DEMO_RESIDENT })).toBeVisible();
  await expect(residents(page).getByRole("row", { name: SECOND_RESIDENT })).toHaveCount(0);
  await expectAccessible(page, "residents in the demo organisation");
  await page.goto(`/people/${SECOND_RESIDENT_ID}`);
  await expect(page.getByRole("heading", { level: 1, name: NOT_FOUND })).toBeVisible();
});
