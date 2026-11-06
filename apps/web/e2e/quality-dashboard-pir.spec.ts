import { expect, type Page, test } from "@playwright/test";
import { expectAccessible, signIn } from "./support";

/**
 * The quality dashboard and PIR figures (QUAL-005, QUAL-006; quality.md sections 22 and 23;
 * HZ-129) against the demo tenant. The owner opens the dashboard: the five indicators Harbour does
 * not record yet say "No data: Harbour does not record this yet", and Harbour House's months
 * before it recorded care here say the period is incomplete, never a rating. Months the wrong way
 * round keep the reader's choice, mark the "To" month and fall back to last month. The owner sets
 * the organisation's falls target (refused the wrong way round first, said at the field), sets and
 * clears Harbour House's own, and sees the target on the card. Neither page scrolls sideways at
 * 320 px. The Registered Manager is refused a less strict target for the home, then opens the PIR
 * figures: Harbour does not submit the return, each key question is one table in one region, and
 * the figures copy. Every state passes axe in the light and dark themes.
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

/** WCAG 1.4.10: loaded at 320 px wide, as a phone opens it, the page does not scroll sideways. */
async function noSidewaysScroll(page: Page) {
  await page.setViewportSize({ width: 320, height: 800 });
  await page.reload();
  await page.getByRole("heading", { level: 1 }).waitFor();
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    )
    .toBe(true);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.reload();
  await page.getByRole("heading", { level: 1 }).waitFor();
}

const card = (page: Page, name: string) => main(page).getByRole("region", { name, exact: true });

const falls = (page: Page, level: "organisation" | "location") =>
  main(page).getByRole("form", {
    name:
      level === "organisation"
        ? "Set the organisation default for Falls"
        : "Set Harbour House's target for Falls",
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
  await noSidewaysScroll(page);

  // Months the wrong way round: the choice is kept, the "To" month is marked, last month is shown.
  const from = main(page).getByLabel("From", { exact: true });
  const options = await from.locator("option").all();
  const newest = (await options[0]?.getAttribute("value")) ?? "";
  const older = (await options[2]?.getAttribute("value")) ?? "";
  await from.selectOption(newest);
  await main(page).getByLabel("To", { exact: true }).selectOption(older);
  await main(page).getByRole("button", { name: "Show indicators" }).click();
  const to = main(page).getByLabel("To", { exact: true });
  await expect(to).toHaveAttribute("aria-invalid", "true");
  await expect(to).toHaveValue(older);
  await expect(main(page).getByRole("alert").getByText("There is a problem")).toBeVisible();
  await bothThemes(page, "months the wrong way round");

  await main(page).getByRole("link", { name: "Set targets for Harbour House" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Indicator targets" })).toBeVisible();
  await bothThemes(page, "indicator targets");
  await noSidewaysScroll(page);
  const organisation = falls(page, "organisation");
  const within = organisation.getByLabel("Within target at or below");
  await within.fill("300");
  await organisation.getByLabel("Close to target up to").fill("100");
  await organisation
    .getByRole("button", { name: "Save the organisation default for Falls" })
    .click();
  await expect(within).toHaveAccessibleDescription(
    /Within target must be the same as close to target or lower/,
  );
  await bothThemes(page, "target refused");
  await within.fill("100");
  await organisation.getByLabel("Close to target up to").fill("250");
  await organisation
    .getByRole("button", { name: "Save the organisation default for Falls" })
    .click();
  await arrived(page, "Target saved.");

  const home = falls(page, "location");
  await home.getByLabel("Within target at or below").fill("90");
  await home.getByLabel("Close to target up to").fill("200");
  await home.getByRole("button", { name: "Save Harbour House's target for Falls" }).click();
  await arrived(page, "Target saved.");
  await bothThemes(page, "targets saved");
  await main(page).getByRole("button", { name: "Clear Harbour House's target for Falls" }).click();
  await arrived(page, "Target cleared.");

  await main(page).getByRole("link", { name: "Back to the quality dashboard" }).click();
  await expect(
    card(page, "Falls").getByText(
      "Organisation: within target at 100 or lower; close to target up to 250; outside target above 250.",
    ),
  ).toBeVisible();
});

test("the Registered Manager is refused a less strict target, and copies the PIR figures", async ({
  page,
  context,
}) => {
  test.setTimeout(300_000);
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await signIn(page, "manager@example.invalid");
  await page.goto("/quality/dashboard/targets");
  const home = falls(page, "location");
  await home.getByLabel("Within target at or below").fill("500");
  await home.getByLabel("Close to target up to").fill("600");
  await home.getByRole("button", { name: "Save Harbour House's target for Falls" }).click();
  await expect(
    home.getByText(/cannot be less strict than the organisation's/).first(),
  ).toBeVisible();
  await bothThemes(page, "less strict target refused");

  await page.getByRole("link", { name: "PIR figures" }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Provider Information Return figures" }),
  ).toBeVisible();
  await expect(main(page).getByText("Harbour does not submit your return")).toBeVisible();
  for (const area of ["Safe", "Effective", "Caring", "Responsive", "Well-led"]) {
    const region = main(page).getByRole("region", { name: `${area} figures, scrolls sideways` });
    await expect(region).toHaveCount(1);
    await expect(region.getByRole("table", { name: area })).toBeVisible();
  }
  await expect(
    main(page)
      .getByRole("table", { name: "Responsive" })
      .getByText("Not recorded in Harbour yet: complete it from your own records."),
  ).toBeVisible();
  const copy = main(page).getByLabel(/The prefilled figures, one per line/);
  await expect(copy).toHaveValue(/^Harbour House, /);
  await expect(copy).toHaveValue(/To complete: Complaints in the last 12 months\./);
  await main(page).getByRole("button", { name: "Copy figures" }).click();
  await expect(main(page).getByRole("status").getByText("Figures copied")).toBeVisible();
  await bothThemes(page, "PIR figures");
});
