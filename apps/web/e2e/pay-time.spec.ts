import { type APIRequestContext, expect, type Locator, type Page, test } from "@playwright/test";
import { expectAccessible, signIn, signInWithDemoPasskey } from "./support";

/**
 * Time, absence and pay screens (SCHED-003 to 007, SCHED-010) against the demo tenant. A care
 * worker sees their time and pay but no pay runs, and asks for leave: the form says what is
 * wrong first. The Registered Manager sees the request waiting for a decision, cannot decline it
 * without a reason, and approves it; timesheet approval and working time open, and pay does not.
 * The owner, signed in with the end-to-end passkey (pay is a multi-factor area), opens pay runs
 * and rule sets and is told what each form needs. Leave dates are random in the coming year so
 * re-runs do not overlap. Each state is checked with axe in light and dark themes.
 *
 * Statutory leave is never declined (H-970): the care worker asks for parental leave on the screen
 * and maternity leave through the API; the manager is offered no "Decline" for either, approves
 * the maternity leave (its only choice, already chosen), and postpones the parental leave, first
 * seeing every error the empty postponement has, then giving new dates of the same length and the
 * confirmation about the child.
 */

test.describe.configure({ mode: "serial" });

const main = (page: Page) => page.getByRole("main");
const nav = (page: Page) => page.getByRole("navigation", { name: "Modules" });
const region = (page: Page, name: string) => main(page).getByRole("region", { name });

async function bothThemes(page: Page, name: string) {
  await expectAccessible(page, `${name} (light)`);
  await page.emulateMedia({ colorScheme: "dark" });
  await expectAccessible(page, `${name} (dark)`);
  await page.emulateMedia({ colorScheme: "light" });
}

const ahead = 40 + Math.floor(Math.random() * 300);
const day = (offset: number) => {
  const d = new Date(Date.now() + offset * 86_400_000);
  return {
    day: String(d.getUTCDate()),
    month: String(d.getUTCMonth() + 1),
    year: String(d.getUTCFullYear()),
  };
};
const START = day(ahead);
const END = day(ahead + 2);
const shown = (d: { day: string; month: string; year: string }) =>
  `${d.day.padStart(2, "0")}/${d.month.padStart(2, "0")}/${d.year}`;

const API_URL = process.env.API_URL ?? "http://localhost:4000";
const DEMO_TENANT = "0194d000-0000-7000-8000-000000000001";
const DEMO_HOME = "0194d000-0000-7000-8000-000000000101";
const iso = (d: { day: string; month: string; year: string }) =>
  `${d.year}-${d.month.padStart(2, "0")}-${d.day.padStart(2, "0")}`;
// Statutory leave, on its own random dates in the coming year, apart from the annual leave.
const statutoryAhead = 40 + Math.floor(Math.random() * 120);
const PARENTAL_START = day(statutoryAhead + 400);
const PARENTAL_END = day(statutoryAhead + 401);
const NEW_START = day(statutoryAhead + 414);
const NEW_END = day(statutoryAhead + 415);
const MATERNITY_START = day(statutoryAhead + 450);
const MATERNITY_END = day(statutoryAhead + 600);

async function askThroughApi(request: APIRequestContext, data: object) {
  const response = await request.post(`${API_URL}/v1/absences`, {
    headers: { "x-harbour-tenant": DEMO_TENANT },
    data,
  });
  expect(response.ok(), await response.text()).toBe(true);
}

async function fillDate(group: Locator, d: { day: string; month: string; year: string }) {
  await group.getByLabel("Day", { exact: true }).fill(d.day);
  await group.getByLabel("Month", { exact: true }).fill(d.month);
  await group.getByLabel("Year", { exact: true }).fill(d.year);
}

test("a care worker sees their time and pay, not pay runs, and asks for leave", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await signIn(page, "carer@example.invalid");
  await expect(nav(page).getByRole("link", { name: "Pay", exact: true })).toHaveCount(0);

  await nav(page).getByRole("link", { name: "My time" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "My time" })).toBeVisible();
  await bothThemes(page, "my time");

  await nav(page).getByRole("link", { name: "My pay" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "My pay" })).toBeVisible();
  await bothThemes(page, "my pay");

  await page.goto("/pay");
  await expect(main(page)).toContainText("You do not have access to this");

  await nav(page).getByRole("link", { name: "Absences" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Absences" })).toBeVisible();
  const ask = region(page, "Ask for leave");
  await ask.getByRole("button", { name: "Ask for leave" }).click();
  await expect(ask.getByText("Choose the kind of leave.").first()).toBeVisible();
  await ask.getByRole("heading", { name: "Ask for leave" }).scrollIntoViewIfNeeded();
  await page.evaluate(() => window.scrollBy(0, -80));
  await bothThemes(page, "leave errors");

  await ask.getByRole("radio", { name: "Annual leave" }).check();
  await fillDate(ask.getByRole("group", { name: "First day" }), START);
  await fillDate(ask.getByRole("group", { name: "Last day" }), END);
  await ask.getByRole("button", { name: "Ask for leave" }).click();
  await expect(ask.getByRole("status").filter({ hasText: "Request sent" })).toBeVisible();
  await expect(main(page)).toContainText(`Annual leave from ${shown(START)} to ${shown(END)}`);
  await bothThemes(page, "leave asked");
});

test("the manager declines only with a reason, approves the leave, and opens timesheets", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await signIn(page, "manager@example.invalid");
  await nav(page).getByRole("link", { name: "Absences" }).click();
  const request = main(page)
    .getByRole("article")
    .filter({ hasText: `Annual leave from ${shown(START)} to ${shown(END)}` });
  await expect(request.getByText("Waiting for a decision")).toBeVisible();

  await request.getByRole("radio", { name: "Decline" }).check();
  await request.getByRole("button", { name: "Save decision" }).click();
  await expect(
    request.getByText("Give a reason of at least 3 characters when you decline.").first(),
  ).toBeVisible();
  await bothThemes(page, "decision errors");

  await request.getByRole("radio", { name: "Approve" }).check();
  await request.getByRole("button", { name: "Save decision" }).click();
  // The form is gone after the refresh: the decision is announced and focus goes to the heading.
  await expect(page.getByRole("heading", { level: 1, name: "Absences" })).toBeFocused();
  await expect(request.getByText("Approved").first()).toBeVisible();
  await bothThemes(page, "leave approved");

  await nav(page).getByRole("link", { name: "Timesheets" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Timesheets" })).toBeVisible();
  await bothThemes(page, "timesheets");

  await expect(nav(page).getByRole("link", { name: "Pay", exact: true })).toHaveCount(0);
});

test("a care worker asks for parental leave and maternity leave", async ({ page }) => {
  test.setTimeout(120_000);
  await signIn(page, "carer@example.invalid");
  await nav(page).getByRole("link", { name: "Absences" }).click();
  const ask = region(page, "Ask for leave");
  await ask.getByRole("radio", { name: "Parental leave" }).check();
  await fillDate(ask.getByRole("group", { name: "First day" }), PARENTAL_START);
  await fillDate(ask.getByRole("group", { name: "Last day" }), PARENTAL_END);
  await ask.getByRole("button", { name: "Ask for leave" }).click();
  await expect(ask.getByRole("status").filter({ hasText: "Request sent" })).toBeVisible();
  // Maternity leave is not asked for on this screen; the API takes it as any leave request.
  await askThroughApi(page.request, {
    locationId: DEMO_HOME,
    kind: "maternity",
    startsOn: iso(MATERNITY_START),
    endsOn: iso(MATERNITY_END),
  });
});

test("the manager is never offered a decline for statutory leave, approves maternity leave and postpones parental leave", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await signIn(page, "manager@example.invalid");
  await nav(page).getByRole("link", { name: "Absences" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Absences" })).toBeVisible();

  // Maternity leave: approve is the only choice, already chosen, and the screen says why.
  const maternity = main(page)
    .getByRole("article")
    .filter({
      hasText: `Maternity leave from ${shown(MATERNITY_START)} to ${shown(MATERNITY_END)}`,
    });
  await expect(maternity.getByText("Waiting for a decision")).toBeVisible();
  await expect(maternity.getByRole("radio", { name: "Decline" })).toHaveCount(0);
  await expect(maternity.getByRole("radio", { name: "Postpone" })).toHaveCount(0);
  await expect(maternity.getByRole("radio", { name: "Approve" })).toBeChecked();
  await expect(maternity.getByText("The law does not let you refuse this leave.")).toBeVisible();
  await maternity.getByRole("button", { name: "Save decision" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Absences" })).toBeFocused();
  await expect(maternity.getByText("Approved").first()).toBeVisible();

  // Parental leave: approve or postpone, never decline.
  const parental = main(page)
    .getByRole("article")
    .filter({
      hasText: `Parental leave from ${shown(PARENTAL_START)} to ${shown(PARENTAL_END)}`,
    });
  await expect(parental.getByText("Waiting for a decision")).toBeVisible();
  await expect(parental.getByRole("radio", { name: "Decline" })).toHaveCount(0);
  await expect(parental.getByRole("radio", { name: "Approve" })).toBeVisible();
  await parental.getByRole("radio", { name: "Postpone" }).check();
  await parental.getByRole("button", { name: "Save decision" }).click();
  await expect(
    parental.getByText("The new first day must include a day, month and year").first(),
  ).toBeVisible();
  await expect(
    parental.getByText("The new last day must include a day, month and year").first(),
  ).toBeVisible();
  await expect(
    parental.getByText("Confirm this to postpone parental leave.").first(),
  ).toBeVisible();
  await expect(
    parental.getByText("Give a reason of at least 3 characters when you postpone.").first(),
  ).toBeVisible();
  await bothThemes(page, "postponement errors");

  await fillDate(parental.getByRole("group", { name: "New first day" }), NEW_START);
  await fillDate(parental.getByRole("group", { name: "New last day" }), NEW_END);
  await parental.getByRole("checkbox", { name: /does not start on the day the child/ }).check();
  await parental.getByRole("textbox", { name: /Reason/ }).fill("Two others are away that week");
  await parental.getByRole("button", { name: "Save decision" }).click();
  // The form is gone after the refresh: the decision is announced and focus goes to the heading.
  await expect(page.getByRole("heading", { level: 1, name: "Absences" })).toBeFocused();
  await expect(parental.getByText("Postponed", { exact: true })).toBeVisible();
  await expect(
    parental.getByText(`New dates: ${shown(NEW_START)} to ${shown(NEW_END)}.`),
  ).toBeVisible();
  await bothThemes(page, "leave postponed");
});

test("the owner opens pay runs and rule sets, and each form says what it needs", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await signInWithDemoPasskey(page, "owner");
  await nav(page).getByRole("link", { name: "Pay", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Pay" })).toBeVisible();
  await bothThemes(page, "pay runs");

  const start = region(page, "Start a pay run");
  await start.getByRole("button", { name: "Start pay run" }).click();
  await expect(
    start.getByText(/The first day of the period must include a day, month and year/).first(),
  ).toBeVisible();
  await start.getByRole("heading", { name: "Start a pay run" }).scrollIntoViewIfNeeded();
  await page.evaluate(() => window.scrollBy(0, -80));
  await bothThemes(page, "pay run errors");

  await main(page).getByRole("link", { name: "Pay rule sets" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Pay rule sets" })).toBeVisible();
  const draft = region(page, "Draft a rule set");
  await draft.getByRole("textbox", { name: "Hourly rates by role" }).fill("carer is twelve");
  await draft.getByRole("button", { name: "Save draft rule set" }).click();
  await expect(draft.getByText(/Write each rate on its own line/).first()).toBeVisible();
  await draft.getByRole("heading", { name: "Draft a rule set" }).scrollIntoViewIfNeeded();
  await page.evaluate(() => window.scrollBy(0, -80));
  await bothThemes(page, "rule set errors");
});
