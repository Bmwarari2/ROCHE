import { expect, type Page, test } from "@playwright/test";
import { expectAccessible, signIn } from "./support";

/**
 * The quality dashboard and PIR figures (QUAL-005, QUAL-006; quality.md section 22; HZ-129)
 * against the demo tenant. The owner opens the dashboard: the five indicators Harbour does not
 * record yet say "No data: Harbour does not record this yet", and Harbour House's months before it
 * recorded care here say the period is incomplete, never a rating. A "to" month before the "from"
 * month falls back to last month and says so. The owner sets the organisation's falls target
 * (refused the wrong way round first), sets and clears Harbour House's own, and sees the target on
 * the card. The Registered Manager is refused a looser target for the home, then opens the PIR
 * figures: Harbour does not submit the return, each key question is a table, and the text to copy
 * lists what to complete. Every state passes axe in the light and dark themes.
 */

test.describe.configure({ mode: "serial" });

const main = (page: Page) => page.getByRole("main");

async function bothThemes(page: Page, name: string) {
  await page.emulateMedia({ colorScheme: "light" });
  await expectAccessible(page, name);
  await page.emulateMedia({ colorScheme: "dark" });
  await expectAccessible(page, `${name}, dark theme`);
  await page.emulateMedia({ colorScheme: "light" });
}

async function arrived(page: Page, words: string) {
  await expect(page.getByRole("heading", { level: 1 })).toBeFocused();
  await expect(main(page).getByRole("status").filter({ hasText: words })).toBeVisible();
}

const card = (page: Page, name: string) => main(page).getByRole("region", { name, exact: true });

const falls = (page: Page, level: "organisation" | "location") =>
  main(page)
    .getByRole("region", { name: "Falls", exact: true })
    .getByRole("form", {
      name:
        level === "organisation" ? "Set the organisation default" : "Set Harbour House's target",
    });

test("hazard HZ-129 the dashboard never rates what it cannot count, and takes the organisation's targets", async ({
  page,
}) => {
  test.setTimeout(300_000);
  await signIn(page, "owner@example.invalid");
  await page.getByRole("link", { name: "Quality dashboard" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Quality dashboard" })).toBeVisible();
  for (const name of [
    "Missed visits",
    "Training compliance",
    "Agency hours",
    "Complaints",
    "Staff turnover",
  ]) {
    await expect(
      card(page, name).getByText("No data: Harbour does not record this yet."),
    ).toBeVisible();
    await expect(card(page, name).getByText("No rating")).toBeVisible();
  }
  await expect(
    card(page, "Falls").getByText(/this period is not complete in Harbour/),
  ).toBeVisible();
  await bothThemes(page, "quality dashboard");

  // Months the wrong way round fall back to last month and say so.
  const months = main(page).getByLabel("From", { exact: true });
  const options = await months.locator("option").allTextContents();
  await months.selectOption({ label: options[0] ?? "" });
  await main(page)
    .getByLabel("To", { exact: true })
    .selectOption({ label: options[2] ?? "" });
  await main(page).getByRole("button", { name: "Show" }).click();
  await expect(
    main(page).getByText(/Choose a "to" month on or after the "from" month/),
  ).toBeVisible();
  await bothThemes(page, "months the wrong way round");

  await main(page).getByRole("link", { name: "Set targets for Harbour House" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Indicator targets" })).toBeVisible();
  await bothThemes(page, "indicator targets");
  const organisation = falls(page, "organisation");
  await organisation.getByLabel("Green at or below").fill("300");
  await organisation.getByLabel("Amber at or below").fill("100");
  await organisation
    .getByRole("button", { name: /Save the organisation default for Falls/ })
    .click();
  await expect(
    organisation.getByText("Green must be the same as amber or lower").first(),
  ).toBeVisible();
  await bothThemes(page, "target refused");
  await organisation.getByLabel("Green at or below").fill("100");
  await organisation.getByLabel("Amber at or below").fill("250");
  await organisation
    .getByRole("button", { name: /Save the organisation default for Falls/ })
    .click();
  await arrived(page, "Target saved.");

  const home = falls(page, "location");
  await home.getByLabel("Green at or below").fill("90");
  await home.getByLabel("Amber at or below").fill("200");
  await home.getByRole("button", { name: /Save Harbour House's target for Falls/ }).click();
  await arrived(page, "Target saved.");
  await bothThemes(page, "targets saved");
  await main(page).getByRole("button", { name: "Clear the location target for Falls" }).click();
  await arrived(page, "Target cleared.");

  await main(page).getByRole("link", { name: "Back to the quality dashboard" }).click();
  await expect(
    card(page, "Falls").getByText("Organisation: green at 100 or lower, amber at 250 or lower."),
  ).toBeVisible();
});

test("the Registered Manager is refused a looser target, and reads the PIR figures to copy", async ({
  page,
}) => {
  test.setTimeout(300_000);
  await signIn(page, "manager@example.invalid");
  await page.goto("/quality/dashboard/targets");
  const home = falls(page, "location");
  await home.getByLabel("Green at or below").fill("500");
  await home.getByLabel("Amber at or below").fill("600");
  await home.getByRole("button", { name: /Save Harbour House's target for Falls/ }).click();
  await expect(home.getByText(/cannot be looser than the organisation's/).first()).toBeVisible();
  await bothThemes(page, "looser target refused");

  await page.getByRole("link", { name: "PIR figures" }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Provider Information Return" }),
  ).toBeVisible();
  await expect(main(page).getByText("Harbour does not submit your return")).toBeVisible();
  for (const area of ["Safe", "Effective", "Caring", "Responsive", "Well-led"]) {
    await expect(main(page).getByRole("table", { name: area })).toBeVisible();
  }
  await expect(
    main(page)
      .getByRole("table", { name: "Responsive" })
      .getByText("Not recorded in Harbour yet: complete it from your own records."),
  ).toBeVisible();
  const copy = main(page).getByLabel(/The prefilled figures, one per line/);
  await expect(copy).toHaveValue(/To complete: Complaints in the last 12 months/);
  await bothThemes(page, "PIR figures");
});
