import { expect, type Page, test } from "@playwright/test";
import { addDemoPasskey, expectAccessible, signIn, signInWithDemoPasskey } from "./support";

/**
 * Sample data mode on the web (PLAT-018; platform-completions.md rules 29 to 32; HZ-072), in the
 * starter organisation the end-to-end seed keeps empty (it has never had a real person). The
 * owner loads sample data after a confirmation; the banner shows on every screen, each sample
 * person carries the "Sample" badge on the people list and their record, and "Sample data is
 * removed" blocks go-live. Removal asks again, is refused in words without a fresh step-up, and
 * succeeds after one. Every state is checked with axe. The journey ends with no sample data, so it
 * can run again on the same database.
 */

test.describe.configure({ mode: "serial" });

const PAGE = "/settings/onboarding";
const OWNER = "starter.owner@example.invalid";
const main = (page: Page) => page.getByRole("main");
const banner = (page: Page) =>
  page.getByRole("status").filter({ hasText: "Sample data is in use" });
const card = (page: Page) =>
  main(page)
    .locator("section")
    .filter({ has: page.getByRole("heading", { level: 2, name: "Sample data" }) });
const item = (page: Page, title: string) =>
  main(page)
    .getByRole("listitem")
    .filter({ has: page.getByRole("heading", { level: 3, name: title }) });
const dialog = (page: Page) => page.getByRole("dialog");

/** Removes sample data with a fresh step-up, as a person would; the page then says so. */
async function removeWithStepUp(page: Page) {
  await signInWithDemoPasskey(page, "starter");
  await page.goto(PAGE);
  await card(page).getByRole("button", { name: "Remove sample data" }).click();
  await dialog(page).getByRole("button", { name: "Remove sample data" }).click();
  await expect(main(page).getByText("Sample data removed.")).toBeVisible();
}

test.beforeAll(async ({ browser }, testInfo) => {
  // An earlier run that stopped half way may have left sample data in place.
  test.setTimeout(120_000);
  const context = await browser.newContext({ baseURL: testInfo.project.use.baseURL });
  const page = await context.newPage();
  await signIn(page, OWNER);
  await page.goto(PAGE);
  if (await card(page).getByRole("button", { name: "Remove sample data" }).isVisible()) {
    await removeWithStepUp(page);
  }
  await context.close();
});

test("the owner loads sample data, which is marked on every screen and blocks go-live", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await signIn(page, OWNER);
  await page.goto(PAGE);
  await expect(card(page).getByText("No sample data is loaded.")).toBeVisible();
  await expect(banner(page)).toHaveCount(0);
  await expect(item(page, "Sample data is removed")).toContainText("Done");
  await expectAccessible(page, "sample data, none loaded");

  await card(page).getByRole("button", { name: "Load sample data" }).click();
  await expect(dialog(page).getByText(/Harbour adds 4 invented people/)).toBeVisible();
  await expectAccessible(page, "load sample data, confirmation");
  await dialog(page).getByRole("button", { name: "Load sample data" }).click();

  await expect(main(page).getByText("Sample data loaded.")).toBeVisible();
  await expect(banner(page)).toBeVisible();
  await expect(card(page).getByText(/^Sample data is loaded\./)).toBeVisible();
  await expect(item(page, "Sample data is removed")).toContainText("Not done: blocks go-live");
  await expectAccessible(page, "sample data loaded");

  // The people list: every sample person carries the badge, an icon and a word.
  await page.goto("/people");
  await expect(banner(page)).toBeVisible();
  const rows = main(page).getByRole("row").filter({ hasText: "Example" });
  await expect(rows).toHaveCount(4);
  for (const row of await rows.all()) {
    await expect(row.locator("[data-sample-badge]")).toHaveText("Sample");
    await expect(row.locator("[data-sample-badge] svg")).toHaveCount(1);
  }
  await expectAccessible(page, "people list with sample people");

  // Their record says so beside the name.
  await rows.first().getByRole("link").first().click();
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Person details" }).locator("[data-sample-badge]"),
  ).toHaveText("Sample");
  await expect(banner(page)).toBeVisible();
  await expectAccessible(page, "a sample person's record");
});

test("removal asks again, is refused without a fresh step-up, and then removes everything", async ({
  page,
}) => {
  test.setTimeout(120_000);
  // The password alone never counts as a step-up.
  await signIn(page, OWNER);
  await page.goto(PAGE);
  await card(page).getByRole("button", { name: "Remove sample data" }).click();
  await expect(dialog(page).getByText(/It cannot be undone\./)).toBeVisible();
  await expectAccessible(page, "remove sample data, confirmation");
  await dialog(page).getByRole("button", { name: "Remove sample data" }).click();
  await expect(dialog(page).getByText(/before you remove sample data\./)).toBeVisible();
  await expectAccessible(page, "remove sample data, step-up needed");
  // Confirming comes back to the sample data section, not the top of the page.
  const again = dialog(page).getByRole("link", { name: "Sign in again" });
  expect(
    new URL((await again.getAttribute("href")) ?? "", "http://x").searchParams.get("next"),
  ).toBe(`${PAGE}#sample-data`);
  await again.click();
  await page.waitForURL((url) => url.pathname === "/sign-in");
  await addDemoPasskey(page, "starter");
  await page.getByRole("button", { name: "Sign in with a passkey" }).click();
  await page.waitForURL((url) => url.pathname === PAGE && url.hash === "#sample-data");
  await expect(card(page)).toBeInViewport();
  await expect(banner(page)).toBeVisible();

  // Now stepped up: removal goes through.
  await card(page).getByRole("button", { name: "Remove sample data" }).click();
  await dialog(page).getByRole("button", { name: "Remove sample data" }).click();
  await expect(main(page).getByText("Sample data removed.")).toBeVisible();
  await expect(banner(page)).toHaveCount(0);
  await expect(card(page).getByText("No sample data is loaded.")).toBeVisible();
  await expect(item(page, "Sample data is removed")).toContainText("Done");
  await expectAccessible(page, "sample data removed");

  await page.goto("/people");
  await expect(main(page).locator("[data-sample-badge]")).toHaveCount(0);
});
