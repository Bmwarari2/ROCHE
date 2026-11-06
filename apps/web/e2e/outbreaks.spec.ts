import { expect, type Locator, type Page, test } from "@playwright/test";
import { demoPerson, expectAccessible, signIn } from "./support";

/**
 * Phase 2 slice 63: the outbreak screens against the demo tenant (SAFE-013). The manager declares
 * an outbreak at Harbour House of an illness not already open there, records a resident's
 * line-list row, updates it by superseding it (HZ-013), and finds closing refused in words until
 * the UKHSA report is decided. Text is marked with the run.
 */

const API_URL = process.env.API_URL ?? "http://localhost:4000";
const DEMO_TENANT = "0194d000-0000-7000-8000-000000000001";
const DEMO_LOCATION = "0194d000-0000-7000-8000-000000000101";
const RUN = `run ${Date.now().toString(36)}`;

async function accessibleInBothThemes(page: Page, name: string) {
  await page.emulateMedia({ colorScheme: "dark" });
  await expectAccessible(page, `${name} (dark)`);
  await page.emulateMedia({ colorScheme: "light" });
  await expectAccessible(page, `${name} (light)`);
}

/** Fills a date field's boxes, found by its legend, with a UK date offset from today. */
async function fillDate(page: Page | Locator, legend: string, daysAgo: number) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).formatToParts(new Date(Date.now() - daysAgo * 86_400_000));
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const group = page.getByRole("group", { name: legend });
  await group.getByLabel("Day").fill(part("day"));
  await group.getByLabel("Month").fill(part("month"));
  await group.getByLabel("Year").fill(part("year"));
}

test("SAFE-013 the manager declares an outbreak, records and updates a case, and cannot close it before the report", async ({
  page,
  context,
}) => {
  test.setTimeout(180_000);
  await signIn(page, "manager@example.invalid");

  // One open outbreak per illness at a home, and closing needs the UKHSA report decided (with
  // step-up), so each run declares an illness not already open there.
  const headers = { "x-harbour-tenant": DEMO_TENANT };
  const open = await context.request.get(
    `${API_URL}/v1/safety/outbreaks?locationId=${DEMO_LOCATION}&state=declared`,
    { headers },
  );
  expect(open.status(), await open.text()).toBe(200);
  const taken = new Set(
    ((await open.json()) as { items: { syndrome: string }[] }).items.map((i) => i.syndrome),
  );
  const illness = (
    [
      ["other", "Other"],
      ["flu", "Flu"],
      ["acute_respiratory", "Acute respiratory infection"],
      ["diarrhoea_vomiting", "Diarrhoea and vomiting"],
      ["covid_19", "COVID-19"],
    ] as const
  ).find(([key]) => !taken.has(key));
  test.skip(!illness, "Every illness already has an open outbreak at the demo home.");
  const [, illnessLabel] = illness ?? ["other", "Other"];

  await page.goto("/outbreaks");
  await expect(page.getByRole("heading", { level: 1, name: "Outbreaks" })).toBeVisible();
  await accessibleInBothThemes(page, "outbreaks list");

  await page
    .getByRole("group", { name: "Which illness" })
    .getByLabel(illnessLabel, { exact: true })
    .check();
  await page.getByLabel("Organism").fill(`Norovirus suspected (${RUN})`);
  await page.getByRole("button", { name: "Declare outbreak" }).click();
  await page.waitForURL(/\/outbreaks\/[0-9a-f-]{36}$/);
  await expect(page.getByText("Declared", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Open the UKHSA report in notifications" }),
  ).toBeVisible();
  await accessibleInBothThemes(page, "outbreak record");

  // The new-case form's resident picker (the line list also says "Resident" elsewhere).
  await page.getByRole("combobox", { name: "Resident", exact: true }).selectOption(demoPerson(1));
  await fillDate(page, "When symptoms started", 1);
  await page.getByRole("group", { name: "Symptoms" }).getByLabel("Vomiting").check();
  await page.getByRole("button", { name: "Add to the line list" }).click();
  await expect(page.getByText("Current", { exact: true }).first()).toBeVisible();
  // The line list with a row in it, and its update form, scanned in both themes.
  await accessibleInBothThemes(page, "outbreak record with a line-list row");

  // HZ-013: they recovered, so the row is updated (superseded), never added a second time.
  const update = page.locator("details").filter({ hasText: "Update this case" }).first();
  await update.locator("summary").click();
  await update.getByLabel("Their condition or test result changed").check();
  await update
    .getByRole("group", { name: /How they are/ })
    .getByLabel("Recovered")
    .check();
  await fillDate(update, "When that changed", 0);
  await update.getByRole("button", { name: "Save the update" }).click();
  await expect(page.getByText("Superseded", { exact: false }).first()).toBeVisible();
  await expect(page.getByText("Current", { exact: true })).toHaveCount(1);

  await fillDate(page, "Date the outbreak ended", 0);
  await page
    .getByLabel("Why it is closed")
    .fill(`The health protection team agreed it is over (${RUN}).`);
  await page.getByRole("button", { name: "Close the outbreak" }).click();
  // HZ-013: never closed while its UKHSA report is undecided; the refusal says why, in words.
  await expect(page.getByText(/Submit the outbreak report/).first()).toBeVisible();
  await accessibleInBothThemes(page, "outbreak close refused");
});
