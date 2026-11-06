import { expect, type Page, test } from "@playwright/test";
import { expectAccessible, signInWithDemoPasskey } from "./support";

/**
 * The member lifecycle (H-566) against the demo tenant: the manager (platform.user.manage at
 * Harbour House, signed in with their passkey so the step-up is fresh) suspends Lee Leaver, an
 * active care worker with no sign-in seeded for this journey, after a coded reason, then ends the
 * membership, reinstating it once on the way (H-1392); Robin Reporter, whose phone last reported
 * two entries, needs the entries confirmed before suspending and the device check before ending.
 * Each state shows as an icon and a word, and each is checked with axe in the light and dark themes. An ended membership cannot change again, so a re-run against the same database
 * checks the ended page only.
 */

const LEAVER = "0194d000-0000-7000-8000-000000000307";
const REPORTER = "0194d000-0000-7000-8000-000000000308";

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

  // Suspended by mistake: reinstated (H-1392), then suspended again.
  await membership(page).getByRole("button", { name: "Reinstate membership" }).click();
  const reinstate = page.getByRole("dialog", { name: /^Reinstate Lee Leaver's membership/ });
  await expect(reinstate.getByRole("button", { name: "Keep it suspended" })).toBeVisible();
  await bothThemes(page, "reinstate confirmation");
  await reinstate.getByLabel("Reason").selectOption({ label: "They were suspended by mistake" });
  await reinstate.getByRole("button", { name: "Reinstate membership" }).click();
  await expect(reinstate).toBeHidden();
  await expect(
    main(page).getByRole("status").filter({ hasText: "Membership reinstated" }),
  ).toBeFocused();
  await expect(about).toContainText("Active");
  await membership(page).getByRole("button", { name: "Suspend membership" }).click();
  await suspend.getByLabel("Reason").selectOption({ label: "They are leaving" });
  await suspend.getByRole("button", { name: "Suspend membership" }).click();
  await expect(suspend).toBeHidden();
  await expect(about).toContainText("Suspended");

  // By keyboard: open, close with Escape (focus returns to the trigger), open again.
  const endTrigger = membership(page).getByRole("button", { name: "End membership" });
  await endTrigger.focus();
  await page.keyboard.press("Enter");
  const end = page.getByRole("dialog", { name: /^End Lee Leaver's membership/ });
  await expect(end).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(end).toBeHidden();
  await expect(endTrigger).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(end).toContainText("cannot be undone");
  await expect(end.getByRole("button", { name: "Keep membership" })).toBeVisible();
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

test("a member whose phone reported entries: confirmed before suspending, device checked before ending", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await signInWithDemoPasskey(page);
  await page.goto(`/settings/team/${REPORTER}`);
  await expect(page.getByRole("heading", { level: 1, name: "Robin Reporter" })).toBeVisible();
  const about = main(page).getByRole("region", { name: "Role and status" });
  if (await about.getByText("Ended").isVisible()) {
    await bothThemes(page, "ended membership with a device");
    return;
  }
  await expect(membership(page)).toContainText("They used 1 device for Care mode.");
  await expect(membership(page)).toContainText(
    "Their phone last reported 2 care entries not yet sent.",
  );
  await bothThemes(page, "active membership with entries waiting");

  await membership(page).getByRole("button", { name: "Suspend membership" }).click();
  const suspend = page.getByRole("dialog", { name: /^Suspend Robin Reporter's membership/ });
  await suspend.getByLabel("Reason").selectOption({ label: "They are leaving" });
  await suspend.getByRole("button", { name: "Suspend membership" }).click();
  const confirm = suspend.getByRole("checkbox", { name: /I understand 2 care entries/ });
  await expect(confirm).toBeFocused();
  await expect(confirm).toHaveAttribute("aria-invalid", "true");
  await bothThemes(page, "suspend asks to confirm entries waiting");
  await confirm.check();
  await suspend.getByRole("button", { name: "Suspend membership" }).click();
  await expect(suspend).toBeHidden();
  await expect(about).toContainText("Suspended");

  await membership(page).getByRole("button", { name: "End membership" }).click();
  const end = page.getByRole("dialog", { name: /^End Robin Reporter's membership/ });
  await end.getByLabel("Reason").selectOption({ label: "They left employment" });
  await end.getByRole("button", { name: "End membership" }).click();
  const check = end.getByLabel("How you checked their devices");
  await expect(check).toBeFocused();
  await expect(check).toHaveAttribute("aria-invalid", "true");
  await bothThemes(page, "end asks how the device was checked");
  await check.selectOption({ label: "The device is lost, and an incident was raised" });
  await end.getByRole("button", { name: "End membership" }).click();
  await expect(end).toBeHidden();
  await expect(
    main(page).getByRole("status").filter({ hasText: "Membership ended" }),
  ).toBeFocused();
  await expect(about).toContainText("Ended");
  await bothThemes(page, "ended membership with a device");
});
