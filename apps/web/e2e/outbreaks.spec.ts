import { expect, type Page, test } from "@playwright/test";
import { demoPerson, expectAccessible, signIn } from "./support";

/**
 * Phase 2 slice 63: the outbreak screens against the demo tenant (SAFE-013). The manager declares
 * an outbreak of "other" illness at Harbour House, records a resident's line-list row and closes
 * it. An outbreak of the same illness left open by an earlier run is closed first through the API
 * (one open outbreak per illness per home). Text is marked with the run.
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
async function fillDate(page: Page, legend: string, daysAgo: number) {
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

test("SAFE-013 the manager declares an outbreak, records a case and closes it", async ({
  page,
  context,
}) => {
  await signIn(page, "manager@example.invalid");

  // One open outbreak per illness at a home: close any "other" outbreak an earlier run left open.
  const headers = { "x-harbour-tenant": DEMO_TENANT };
  const open = await context.request.get(
    `${API_URL}/v1/safety/outbreaks?locationId=${DEMO_LOCATION}&state=declared`,
    { headers },
  );
  expect(open.status(), await open.text()).toBe(200);
  const items = (
    (await open.json()) as { items: { id: string; syndrome: string; version: number }[] }
  ).items;
  for (const item of items.filter((i) => i.syndrome === "other")) {
    const closed = await context.request.post(`${API_URL}/v1/safety/outbreaks/${item.id}/close`, {
      headers,
      data: {
        version: item.version,
        closedOn: new Date().toISOString().slice(0, 10),
        reason: `Closed before an end-to-end run (${RUN}).`,
      },
    });
    expect(closed.status(), await closed.text()).toBe(200);
  }

  await page.goto("/outbreaks");
  await expect(page.getByRole("heading", { level: 1, name: "Outbreaks" })).toBeVisible();
  await accessibleInBothThemes(page, "outbreaks list");

  await page.getByRole("group", { name: "Which illness" }).getByLabel("Other").check();
  await page.getByLabel("Organism").fill(`Norovirus suspected (${RUN})`);
  await page.getByRole("button", { name: "Declare outbreak" }).click();
  await page.waitForURL(/\/outbreaks\/[0-9a-f-]{36}$/);
  await expect(page.getByText("Declared", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Open the UKHSA report in notifications" }),
  ).toBeVisible();
  await accessibleInBothThemes(page, "outbreak record");

  await page.getByLabel("Resident").selectOption(demoPerson(1));
  await fillDate(page, "When symptoms started", 1);
  await page.getByRole("group", { name: "Symptoms" }).getByLabel("Vomiting").check();
  await page.getByRole("button", { name: "Add to the line list" }).click();
  await expect(page.getByText("Current", { exact: true }).first()).toBeVisible();

  await fillDate(page, "Date the outbreak ended", 0);
  await page
    .getByLabel("Why it is closed")
    .fill(`The health protection team agreed it is over (${RUN}).`);
  await page.getByRole("button", { name: "Close the outbreak" }).click();
  await expect(page.getByText("Closed", { exact: true })).toBeVisible();
  await accessibleInBothThemes(page, "closed outbreak");
});
