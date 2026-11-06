import { expect, type Page, test } from "@playwright/test";
import { expectAccessible, signInWithDemoPasskey } from "./support";

/**
 * Importing medicines, care plans and staff files in the wizard (platform.md rules 27 to 31; slice
 * 51; hazards HZ-130 and HZ-024). The owner chooses what the file holds, uploads an invented care
 * plans file (a demo person's 999-range NHS number and one nobody has), checks it, reads every
 * row's outcome in words with an icon (never colour alone), and discards it. Checked with axe in
 * light and dark.
 */

test.describe.configure({ mode: "serial" });

const main = (page: Page) => page.getByRole("main");

async function accessibleInBothThemes(page: Page, name: string) {
  await page.emulateMedia({ colorScheme: "light" });
  await expectAccessible(page, `${name} (light)`);
  await page.emulateMedia({ colorScheme: "dark" });
  await expectAccessible(page, `${name} (dark)`);
  await page.emulateMedia({ colorScheme: "light" });
}

const CARE_PLANS = [
  "person_nhs_number,domain,need,outcome",
  "9990000018,mobility,Needs one carer to walk to the dining room.,Walks safely to meals.",
  "9990000107,mobility,Needs one carer to walk.,Walks safely.",
].join("\n");

test("hazard HZ-130 the owner checks a care plans file and reads every row's outcome", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await signInWithDemoPasskey(page, "owner");
  await page.goto("/settings/import");
  const upload = page.getByRole("region", { name: "Upload a file" });
  await upload.getByLabel("What the file holds").selectOption("care_plans");
  await accessibleInBothThemes(page, "import type chosen");
  await upload.getByLabel("Home").selectOption({ index: 1 });
  await upload.getByLabel("CSV file").setInputFiles({
    name: "care-plans.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(CARE_PLANS),
  });
  await expect(upload.getByLabel("Column 2: domain")).toHaveValue("domain");
  await upload.getByRole("button", { name: "Upload for checking" }).click();
  await expect(main(page).getByRole("status").filter({ hasText: "File uploaded." })).toBeVisible();

  await main(page).getByRole("button", { name: "Check the file" }).click();
  const report = page.getByRole("region", { name: "What the check found" });
  const rows = report.getByRole("region", { name: "Every row" });
  await expect(rows.getByText("Row 2: refused, correct it in the file")).toBeVisible();
  await expect(rows.getByRole("listitem")).toHaveCount(2);
  await expect(report.getByText("never matched by name")).toBeVisible();
  // People's allergy questions are not asked of a care plans file.
  await expect(report.getByRole("heading", { name: /allerg/i })).toHaveCount(0);
  await accessibleInBothThemes(page, "care plans report");

  await main(page).getByRole("button", { name: "Discard this file" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Discard file" }).click();
  await expect(main(page).getByText("Discarded", { exact: true })).toBeVisible();
});
