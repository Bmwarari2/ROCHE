import { expect, type Page, test } from "@playwright/test";
import { expectAccessible, signIn, signInWithDemoPasskey } from "./support";

/**
 * Break-glass search (platform-completions.md rule 9; hazards HZ-001 and HZ-011): the Registered
 * Manager finds a resident of another home by full name, after choosing a reason and typing it,
 * confirmed with their passkey; the results are read-only identity, never where the person lives.
 * With a password alone the search asks for the passkey first. Axe checks every state.
 */

const dialog = (page: Page) => page.getByRole("dialog", { name: "Search outside your access" });

async function openDialog(page: Page) {
  await page.goto("/search");
  await page.getByRole("button", { name: "Search outside your access" }).click();
  await expect(dialog(page)).toBeVisible();
}

async function fill(page: Page, reason: string) {
  const d = dialog(page);
  await d.getByLabel("Full name or NHS number").fill("Una Example");
  await d.getByLabel("Why you need to find them").selectOption({ label: "Emergency care" });
  await d.getByLabel("Reason", { exact: true }).fill(reason);
}

test("hazard HZ-011 hazard HZ-001 a manager finds a resident of another home with break-glass, identity only", async ({
  page,
}) => {
  await signInWithDemoPasskey(page);
  // Una lives at Harbour Mews, outside the manager's home: ordinary search does not find her.
  await page.goto("/search");
  const box = page.getByRole("searchbox", { name: "Search for" });
  await box.fill("Una Example");
  await box.press("Enter");
  await expect(page.getByRole("region", { name: /result/ })).toContainText(
    "Nothing you can see matches.",
  );

  await openDialog(page);
  await expectAccessible(page, "break-glass search dialog");

  // A reason too short is said at the field, before anything is sent.
  await fill(page, "Need her now");
  await dialog(page).getByRole("button", { name: "Search with break-glass" }).click();
  await expect(dialog(page).getByRole("alert")).toContainText("characters or more");
  await expectAccessible(page, "reason too short");

  await fill(page, "Paramedics on the phone asking about her medicines tonight");
  await dialog(page).getByRole("button", { name: "Search with break-glass" }).click();
  const found = dialog(page).getByRole("region", { name: /result/ });
  await expect(found).toContainText("Una Example");
  await expect(found).toContainText("NHS 999 000 1502");
  await expect(found).toContainText("For identifying the person only.");
  // Never where she lives.
  await expect(found).not.toContainText("Harbour Mews");
  await expectAccessible(page, "break-glass results");
});

test("hazard HZ-011 break-glass search asks for the passkey after a password sign-in", async ({
  page,
}) => {
  await signIn(page, "manager@example.invalid");
  await openDialog(page);
  await fill(page, "Paramedics on the phone asking about her medicines tonight");
  await dialog(page).getByRole("button", { name: "Search with break-glass" }).click();
  await expect(dialog(page).getByRole("alert")).toContainText("passkey or authenticator code");
  await expect(dialog(page).getByRole("link", { name: "Sign in again" })).toBeVisible();
  await expectAccessible(page, "step-up needed");
});
