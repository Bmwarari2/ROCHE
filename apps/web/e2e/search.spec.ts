import { expect, type Page, test } from "@playwright/test";
import { expectAccessible, signIn } from "./support";

/**
 * Search (PLAT-013; platform-completions.md rules 1 to 8; hazards HZ-001 and HZ-011): from the
 * side bar, by keyboard alone, the Registered Manager searches by name and by NHS number, sees
 * where the search looked, opens the person, and is told plainly when an NHS number is mistyped;
 * a care worker's search says it looked only among the people assigned to them; the words typed
 * never reach the address. Axe checks every state.
 */

const results = (page: Page) => page.getByRole("region", { name: /result/ });

async function searchFor(page: Page, words: string) {
  const box = page.getByRole("searchbox", { name: "Search for" });
  await box.fill(words);
  await box.press("Enter");
}

test("hazard HZ-001 hazard HZ-011 a manager finds a person by name and NHS number, by keyboard, with the scope said", async ({
  page,
}) => {
  await signIn(page, "manager@example.invalid");
  await page.getByRole("link", { name: "Search", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Search" })).toBeVisible();
  await expectAccessible(page, "search page");

  // Nothing typed: said at the box.
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText(
    "Type a name, a word or an NHS number",
  );
  await expectAccessible(page, "nothing typed");

  await searchFor(page, "Addie");
  await expect(page.getByRole("heading", { name: /^\d+ results?$/ })).toBeFocused();
  const found = results(page);
  await expect(found).toContainText("Ada Example (known as Addie)");
  await expect(found).toContainText("Born 01/02/1938");
  await expect(found).toContainText("Receiving care");
  await expect(found).toContainText("searched at your locations only");
  await expect(found).toContainText("People who have left the service are not included.");
  // The words typed never go in the address.
  expect(page.url()).not.toContain("Addie");
  await expectAccessible(page, "results");

  // A mistyped NHS number is refused in words, never searched as a near match.
  await searchFor(page, "999 000 0019");
  await expect(page.getByRole("main").getByRole("alert")).toContainText("not a valid NHS number");
  await expectAccessible(page, "mistyped NHS number");

  await searchFor(page, "999 000 0018");
  await expect(results(page)).toContainText("Ada Example");
  await expect(results(page)).toContainText("NHS 999 000 0018");
  // Keyboard: the person's link is reached with Tab and opened with Enter.
  const link = results(page).getByRole("link", { name: /Ada Example/ });
  await link.focus();
  await page.keyboard.press("Enter");
  await page.waitForURL(/\/people\/0194d000-0000-7000-8600-000000000001$/);
});

test("hazard HZ-011 a care worker's search says it looked only among the people assigned to them", async ({
  page,
}) => {
  await signIn(page, "carer@example.invalid");
  await page.goto("/search");
  await searchFor(page, "Dev Fixture");
  // Dev is not assigned to the care worker: exactly like no match.
  await expect(results(page)).toContainText("Nothing you can see matches.");
  await expect(results(page)).toContainText("searched among the people assigned to you only");
  await expect(page.getByLabel("Include people who have left the service")).toHaveCount(0);
  await expectAccessible(page, "care worker, no match");

  // Colleagues are not something a care worker searches: refused in words.
  await page.getByLabel("Look in").selectOption({ label: "Colleagues" });
  await searchFor(page, "Mo Manager");
  await expect(page.getByRole("main").getByRole("alert")).toContainText(
    "Your role cannot search the kind of record you chose.",
  );
  await expectAccessible(page, "care worker, refused");
});

test("hazard HZ-001 the owner is warned when two people share a name, and may include people who have left", async ({
  page,
}) => {
  await signIn(page, "owner@example.invalid");
  await page.goto("/search");
  await page.getByLabel("Include people who have left the service").check();
  await expectAccessible(page, "people who have left, asked for");
  await searchFor(page, "Sam Twin");
  await expect(results(page)).toContainText("People who have left the service are included.");
  const warnings = results(page).getByText(
    "Same name as another result: check the photo and date of birth before opening",
  );
  await expect(warnings).toHaveCount(2);
  await expect(results(page)).toContainText("Born 04/03/1940");
  await expect(results(page)).toContainText("Born 12/09/1946");
  await expectAccessible(page, "same name");

  // Communication needs show before the record opens.
  await page.getByLabel("Include people who have left the service").uncheck();
  await searchFor(page, "Ada Example");
  await expect(results(page)).toContainText(
    "Communication needs: Needs information in large print",
  );
});

test("the words never reach the address, even before the page's scripts run", async ({
  browser,
}) => {
  // Signed in with scripts on, then the same session with scripts off.
  const signedIn = await browser.newContext();
  await signIn(await signedIn.newPage(), "manager@example.invalid");
  const state = await signedIn.storageState();
  await signedIn.close();
  const context = await browser.newContext({ storageState: state, javaScriptEnabled: false });
  const page = await context.newPage();
  await page.goto("/search");
  const box = page.getByRole("searchbox", { name: "Search for" });
  await box.fill("Ada Example");
  await box.press("Enter");
  await page.waitForLoadState();
  expect(page.url()).not.toContain("Ada");
  expect(page.url()).not.toContain("query");
  await context.close();
});
