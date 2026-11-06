import { expect, type Page, test } from "@playwright/test";
import { demoPerson, expectAccessible, signIn } from "./support";

/**
 * Phase 2 slice 63: the disclosure request screens (SAFE-016) against the demo tenant. The demo
 * manager logs a police request about a resident, collects their records and sees each record
 * with its decision. Each run marks what it writes with the run. Invented people only.
 */

const RUN = `run ${Date.now().toString(36)}`;

test.describe.configure({ mode: "serial" });

async function accessibleInBothThemes(page: Page, name: string) {
  await page.emulateMedia({ colorScheme: "dark" });
  await expectAccessible(page, `${name} (dark)`);
  await page.emulateMedia({ colorScheme: "light" });
  await expectAccessible(page, `${name} (light)`);
}

async function fillWhen(page: Page, legend: string, at: Date) {
  const group = page.getByRole("group", { name: legend });
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  await group.getByLabel("Day").fill(part("day"));
  await group.getByLabel("Month").fill(part("month"));
  await group.getByLabel("Year").fill(part("year"));
  await group.getByLabel("Hour").fill(part("hour"));
  await group.getByLabel("Minute").fill(part("minute"));
}

test("SAFE-016 the manager logs a police request, collects the records and reviews them", async ({
  page,
}) => {
  await signIn(page, "manager@example.invalid");
  await page.goto("/disclosures");
  await expect(page.getByRole("heading", { level: 1, name: "Disclosure requests" })).toBeVisible();
  await accessibleInBothThemes(page, "disclosure log");

  await page.goto(`/disclosures/new?person=${demoPerson(1)}`);
  await page.getByRole("group", { name: "What kind of request" }).getByLabel("Police").check();
  await page.getByLabel("Who asked").fill("PC Example");
  await page.getByLabel("Their organisation").fill(`Example Constabulary (${RUN})`);
  await page.getByLabel("What they need it for").fill(`An investigation into a theft (${RUN}).`);
  await fillWhen(page, "When the request was received", new Date(Date.now() - 86_400_000));
  await accessibleInBothThemes(page, "new disclosure request");
  await page.getByRole("button", { name: "Log request" }).click();

  await page.waitForURL(/\/disclosures\/[0-9a-f-]{36}$/);
  await expect(page.getByText("Requested", { exact: true })).toBeVisible();
  await expect(page.getByText("Legal basis")).toBeVisible();
  await page.getByRole("button", { name: "Collect the person's records" }).click();
  await expect(page.getByText(/records found:/)).toBeVisible();
  await expect(page.getByText("Still to review").first()).toBeVisible();
  await accessibleInBothThemes(page, "disclosure request record");

  // One collected record, named in plain words (never a table name), reviewed before release.
  await page.locator('a[href*="/items/"]').first().click();
  await page.waitForURL(/\/items\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("heading", { level: 1 })).not.toContainText("_");
  await accessibleInBothThemes(page, "collected record review");
});
