import { expect, type Page, test } from "@playwright/test";
import { demoPerson, expectAccessible, signIn } from "./support";

/**
 * The printable MAR chart (slice 50; MEDS-014; medicines.md section 17): the Medicines tab offers a
 * month and downloads the chart as a PDF; the download is a PDF the browser is told not to keep.
 * Axe runs in light and dark on the tab with the print card.
 */

const main = (page: Page) => page.getByRole("main");

async function bothThemes(page: Page, name: string) {
  await expectAccessible(page, `${name} (light)`);
  await page.emulateMedia({ colorScheme: "dark" });
  await expectAccessible(page, `${name} (dark)`);
  await page.emulateMedia({ colorScheme: "light" });
}

test("hazard HZ-122 hazard HZ-007 the nurse downloads a month's MAR chart as a PDF", async ({
  page,
}) => {
  await signIn(page, "nurse@example.invalid");
  await page.goto(`/people/${demoPerson(1)}/medicines`);
  const card = main(page).getByRole("region", { name: "Print the MAR chart" });
  await expect(card).toContainText("not the live record");
  await bothThemes(page, "the medicines tab with the print card");
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    card.getByRole("button", { name: "Download the MAR chart (PDF)" }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/^mar-\d{4}-\d{2}\.pdf$/);
});
