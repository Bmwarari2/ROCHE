import { expect, type Page, test } from "@playwright/test";
import { expectAccessible, signInWithDemoPasskey } from "./support";

/**
 * The member lifecycle (H-566) against the demo tenant: the manager (platform.user.manage at
 * Harbour House, signed in with their passkey so the step-up is fresh) suspends Lee Leaver, an
 * active care worker with no sign-in seeded for this journey, after a coded reason, then ends the
 * membership. Each state shows as an icon and a word, and each is checked with axe in the light and
 * dark themes. An ended membership cannot change again, so a re-run against the same database
 * checks the ended page only.
 */

const LEAVER = "0194d000-0000-7000-8000-000000000307";

test.describe.configure({ mode: "serial" });

const main = (page: Page) => page.getByRole("main");
const membership = (page: Page) => main(page).getByRole("region", { name: "Membership" });

async function bothThemes(page: Page, name: string) {
  await expectAccessible(page, name);
  await page.emulateMedia({ colorScheme: "dark" });
  await expectAccessible(page, `${name}, dark theme`);
  await page.emulateMedia({ colorScheme: "light" });
}

test("the manager suspends, then ends, a membership after a coded reason", async ({ page }) => {
  test.setTimeout(180_000);
  await signInWithDemoPasskey(page);
  await page.goto(`/settings/team/${LEAVER}`);
  await expect(page.getByRole("heading", { level: 1, name: "Lee Leaver" })).toBeVisible();
  const about = main(page).getByRole("region", { name: "Role and status" });
  if (await about.getByText("Ended").isVisible()) {
    await expect(membership(page).getByRole("button")).toHaveCount(0);
    await bothThemes(page, "ended membership");
    return;
  }
  await expect(about).toContainText("Active");
  await expect(about).toContainText("Care worker");
  await bothThemes(page, "active membership");

  await membership(page).getByRole("button", { name: "Suspend membership" }).click();
  const suspend = page.getByRole("dialog", { name: /^Suspend Lee Leaver's membership/ });
  await expect(suspend).toBeVisible();
  await suspend.getByRole("button", { name: "Suspend membership" }).click();
  await expect(suspend.getByLabel("Reason")).toBeFocused();
  await expect(suspend.getByLabel("Reason")).toHaveAttribute("aria-invalid", "true");
  await bothThemes(page, "suspend with an error");
  await suspend.getByLabel("Reason").selectOption({ label: "They are leaving" });
  await suspend.getByRole("button", { name: "Suspend membership" }).click();
  await expect(suspend).toBeHidden();
  await expect(
    main(page).getByRole("status").filter({ hasText: "Membership suspended" }),
  ).toBeFocused();
  await expect(about).toContainText("Suspended");
  await expect(membership(page)).toContainText("They have not made a sign-in yet.");
  await bothThemes(page, "suspended membership");

  await membership(page).getByRole("button", { name: "End membership" }).click();
  const end = page.getByRole("dialog", { name: /^End Lee Leaver's membership/ });
  await expect(end).toContainText("cannot be undone");
  await bothThemes(page, "end confirmation");
  await end.getByLabel("Reason").selectOption({ label: "They left employment" });
  await end.getByRole("button", { name: "End membership" }).click();
  await expect(end).toBeHidden();
  await expect(
    main(page).getByRole("status").filter({ hasText: "Membership ended" }),
  ).toBeFocused();
  await expect(about).toContainText("Ended");
  await expect(membership(page).getByRole("button")).toHaveCount(0);
  await bothThemes(page, "ended membership");
});
