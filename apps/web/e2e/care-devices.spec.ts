import { expect, type Page, test } from "@playwright/test";
import { expectAccessible, openModules, signIn } from "./support";

/**
 * Care mode phones (MOB-010; HZ-006, HZ-040), against the demo tenant, whose seed has no phones.
 * The Registered Manager finds the page in the navigation and sees the empty list; a phone this
 * person may not see reads as not found; a care worker is offered no page. Each state is checked
 * with axe in light and dark. The withdraw form needs a phone that has synced, which the seed does
 * not give: its rules are unit-tested (`care-devices.test.ts`).
 */

const TITLE = "Care mode phones";
const main = (page: Page) => page.getByRole("main");

async function bothThemes(page: Page, name: string) {
  await expectAccessible(page, `${name} (light)`);
  await page.emulateMedia({ colorScheme: "dark" });
  await expectAccessible(page, `${name} (dark)`);
  await page.emulateMedia({ colorScheme: "light" });
}

test("hazard HZ-040 the Registered Manager finds the Care mode phones", async ({ page }) => {
  await signIn(page, "manager@example.invalid");
  const nav = await openModules(page);
  await nav.getByRole("link", { name: TITLE }).click();
  await expect(page.getByRole("heading", { level: 1, name: TITLE })).toBeVisible();
  await expect(
    main(page).getByRole("heading", { name: "No phone has been used for Care mode here yet" }),
  ).toBeVisible();
  await bothThemes(page, "care mode phones, none yet");

  // A phone the API does not list for this person reads as not found.
  const response = await page.goto("/settings/devices/0199d000-0000-4000-8000-00000000dead");
  expect(response?.status()).toBe(404);
});

test("hazard HZ-040 a care worker is offered no Care mode phones page", async ({ page }) => {
  await signIn(page, "carer@example.invalid");
  const nav = await openModules(page);
  await expect(nav.getByRole("link", { name: TITLE })).toHaveCount(0);
  await page.goto("/settings/devices");
  await expect(page.getByRole("heading", { level: 1, name: TITLE })).toBeVisible();
  await expect(main(page).getByRole("link", { name: /^Phone ending/ })).toHaveCount(0);
  await bothThemes(page, "care mode phones, care worker refused");
});
