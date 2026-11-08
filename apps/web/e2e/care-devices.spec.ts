import { expect, type Page, test } from "@playwright/test";
import { expectAccessible, openModules, signIn } from "./support";

/**
 * Care mode phones (MOB-010; HZ-006, HZ-040), against the demo tenant. The seed has no phones,
 * but other journeys may have used one by now (member-lifecycle reports a phone with entries
 * waiting), so this checks the screen as it is, either way, and never withdraws a phone another
 * journey relies on. The Registered Manager finds the page in the navigation: with no phone, the
 * empty state; with one, its page, what it last reported and the withdraw form, nothing chosen or
 * ticked. A phone this person may not see reads as not found; a care worker is offered no page.
 * Each state is checked with axe in light and dark. The form's rules are component-tested
 * (`DeviceWithdrawForm.test.tsx`).
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
  const list = main(page).getByRole("region", { name: "Phones" });
  await expect(list).toBeVisible();
  const phones = list.getByRole("link", { name: /^Phone ending / });
  if ((await phones.count()) === 0) {
    await expect(
      list.getByRole("heading", { name: "No phone has been used for Care mode here yet" }),
    ).toBeVisible();
    await bothThemes(page, "care mode phones, none yet");
  } else {
    // Each phone says in words whether it is withdrawn, never by colour alone.
    await expect(list.getByText(/^(Withdrawn|Not withdrawn)$/).first()).toBeVisible();
    await bothThemes(page, "care mode phones, listed");
    const name = (await phones.first().textContent()) ?? "";
    await phones.first().click();
    await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();
    await expect(main(page).getByRole("region", { name: "About this phone" })).toBeVisible();
    const withdraw = main(page).getByRole("region", { name: "Withdraw this phone" });
    if ((await withdraw.count()) > 0) {
      // Nothing is chosen or ticked for the manager.
      await expect(withdraw.getByRole("radio", { checked: true })).toHaveCount(0);
      await expect(withdraw.getByRole("checkbox")).not.toBeChecked();
      await expect(withdraw.getByRole("button", { name: "Withdraw this phone" })).toBeVisible();
    }
    await bothThemes(page, "a care mode phone");
  }

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
