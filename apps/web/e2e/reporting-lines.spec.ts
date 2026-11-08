import { type BrowserContext, expect, type Locator, type Page, test } from "@playwright/test";
import { expectAccessible, signIn } from "./support";

/**
 * Reporting lines (ADR-0137, PR 2) against the demo tenant. The owner, who holds the staff file
 * permission organisation-wide, acts as HR: names the demo carer's line manager, changes it and
 * ends it; then adds a team, adds members, marks the lead and archives the team, part of it with
 * the keyboard only. The Registered Manager, at one home, sees the screens read only; a care
 * worker is offered neither screen. Each state is checked with axe in light and dark. The dates
 * are after any line an earlier run left, and each team has its own name, so a rerun works.
 */

const API_URL = process.env.API_URL ?? "http://localhost:4000";
const TENANT = "0194d000-0000-7000-8000-000000000001";
const CARER = "0194d000-0000-7000-8000-000000000304";
const DEMO_LOCATION = "0194d000-0000-7000-8000-000000000101";
const RUN = Date.now().toString(36);
const TEAM = `Night team ${RUN}`;

test.describe.configure({ mode: "serial" });

const sessions: Record<string, Awaited<ReturnType<BrowserContext["cookies"]>>> = {};

test.beforeAll(async ({ browser }, testInfo) => {
  test.setTimeout(180_000);
  for (const user of ["owner", "manager", "carer"]) {
    const context = await browser.newContext({ baseURL: testInfo.project.use.baseURL });
    const page = await context.newPage();
    await signIn(page, `${user}@example.invalid`);
    sessions[user] = await context.cookies();
    await context.close();
  }
});

async function as(page: Page, user: string) {
  await page.context().clearCookies();
  await page.context().addCookies(sessions[user] ?? []);
}

const main = (page: Page) => page.getByRole("main");
const nav = (page: Page) => page.getByRole("navigation", { name: "Modules" });
const form = (page: Page, name: string) => main(page).getByRole("form", { name });

async function bothThemes(page: Page, name: string) {
  await expectAccessible(page, `${name} (light)`);
  await page.emulateMedia({ colorScheme: "dark" });
  await expectAccessible(page, `${name} (dark)`);
  await page.emulateMedia({ colorScheme: "light" });
}

/** A UK date this many days from today, as the API reads dates. */
function ukDay(offset: number) {
  const iso = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(
    new Date(Date.now() + offset * 86_400_000),
  );
  const [year, month, day] = iso.split("-");
  return { iso, year: year ?? "", month: month ?? "", day: day ?? "" };
}

async function fillDate(scope: Locator, legend: string, offset: number) {
  const d = ukDay(offset);
  const group = scope.getByRole("group", { name: legend, exact: true });
  await group.getByLabel("Day").fill(d.day);
  await group.getByLabel("Month").fill(d.month);
  await group.getByLabel("Year").fill(d.year);
}

/** Chooses an option whose words start with the person's name (the job title may follow). */
async function chooseByName(select: Locator, name: string) {
  const value = await select.locator("option", { hasText: name }).first().getAttribute("value");
  await select.selectOption(value ?? "");
}

/** A save said in words, with focus moved to the page's heading. */
async function done(page: Page, words: string) {
  await expect(main(page).getByRole("status").filter({ hasText: words })).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toBeFocused();
}

test("HR names, changes and ends the demo carer's line manager", async ({ page }) => {
  test.setTimeout(180_000);
  await as(page, "owner");
  // The demo carer's staff file, made once through the API (409 when another journey made it).
  const made = await page.request.post(`${API_URL}/v1/workforce/staff-files`, {
    headers: { "x-harbour-tenant": TENANT },
    data: {
      tenantUserId: CARER,
      locationId: DEMO_LOCATION,
      jobTitle: "Care worker",
      pathwayCategory: "care_worker",
      registrationBody: null,
      previousCareWork: false,
      dateOfBirth: null,
      startsOn: null,
      leftOn: null,
    },
  });
  expect([201, 409], await made.text()).toContain(made.status());

  await page.goto("/workforce/staff");
  await main(page).getByRole("link", { name: "Line manager for Cat Carer" }).first().click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Line manager for Cat Carer" }),
  ).toBeVisible();
  await expect(page).toHaveTitle(/Line manager for Cat Carer/);
  const path = new URL(page.url()).pathname;

  // A line an earlier run left open is ended first, after any date this run uses.
  const leftOpen = form(page, "End line management");
  if ((await leftOpen.count()) > 0) {
    await fillDate(leftOpen, "Ends from", 13);
    await leftOpen.getByRole("button", { name: "End line management" }).click();
    await done(page, "Line management has ended.");
  }
  await bothThemes(page, "line manager, none yet");

  // Errors in words first: no manager chosen.
  const name = form(page, "Name a line manager");
  await fillDate(name, "From", 10);
  await name.getByRole("button", { name: "Name line manager" }).click();
  const alert = main(page).getByRole("alert");
  await expect(alert).toBeFocused();
  await expect(alert).toContainText("Line manager: choose one");
  await expect(name.getByLabel("Line manager")).toHaveAttribute("aria-invalid", "true");
  await bothThemes(page, "line manager, an error");

  await chooseByName(name.getByLabel("Line manager"), "Mo Manager");
  await fillDate(name, "From", 10);
  await name.getByRole("button", { name: "Name line manager" }).click();
  await done(page, "The line manager is saved.");
  const now = main(page).getByRole("region", { name: "Line manager now" });
  await expect(now.getByText("Mo Manager")).toBeVisible();
  await expect(now.getByText("Current")).toBeVisible();
  await expect(
    now.getByText(`Since ${ukDay(10).day}/${ukDay(10).month}/${ukDay(10).year}`),
  ).toBeVisible();
  await bothThemes(page, "line manager named");

  const change = form(page, "Change the line manager");
  await chooseByName(change.getByLabel("Line manager"), "Nell Nurse");
  await fillDate(change, "From", 11);
  await change.getByRole("button", { name: "Change line manager" }).click();
  await done(page, "The line manager is saved.");
  await expect(now.getByText("Nell Nurse")).toBeVisible();
  const before = main(page).getByRole("region", { name: "Earlier line managers" });
  await expect(before.getByText("Mo Manager").first()).toBeVisible();
  await expect(before.getByText("Ended").first()).toBeVisible();

  // Ending the line with the keyboard only: the date, then the button.
  const end = form(page, "End line management");
  const endDay = ukDay(12);
  const group = end.getByRole("group", { name: "Ends from", exact: true });
  await group.getByLabel("Day").focus();
  await page.keyboard.press("Control+A");
  await page.keyboard.type(endDay.day);
  await page.keyboard.press("Tab");
  await page.keyboard.press("Control+A");
  await page.keyboard.type(endDay.month);
  await page.keyboard.press("Tab");
  await page.keyboard.press("Control+A");
  await page.keyboard.type(endDay.year);
  await page.keyboard.press("Tab");
  await expect(end.getByRole("button", { name: "End line management" })).toBeFocused();
  await page.keyboard.press("Enter");
  await done(page, "Line management has ended.");
  await expect(now.getByText("No line manager is recorded.")).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`${path}`));
  await bothThemes(page, "line manager ended");
});

test("HR adds a team, its members and its lead, then archives it", async ({ page }) => {
  test.setTimeout(180_000);
  await as(page, "owner");
  await page.goto("/");
  await nav(page).getByRole("link", { name: "Staff teams" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Staff teams" })).toBeVisible();
  await bothThemes(page, "staff teams");

  const add = form(page, "Add a team");
  await add.getByLabel("Team name").fill(TEAM);
  await add.getByLabel("Home").selectOption({ label: "Harbour House" });
  await add.getByRole("button", { name: "Add team" }).click();
  await done(page, "The team is added.");
  const other = form(page, "Add a team");
  await other.getByLabel("Team name").fill(`${TEAM} days`);
  await other.getByRole("button", { name: "Add team" }).click();
  await done(page, "The team is added.");
  await main(page).getByRole("link", { name: TEAM, exact: true }).click();
  await expect(page).toHaveTitle(new RegExp(TEAM));

  // A name already in use is refused (409) in words at its field, with focus on the summary.
  const rename = form(page, "Rename or move the team");
  await rename.getByLabel("Team name").fill(`${TEAM} days`);
  await rename.getByRole("button", { name: "Save team" }).click();
  const taken = main(page).getByRole("alert");
  await expect(taken).toBeFocused();
  await expect(taken).toContainText("Choose another name for the team");
  await expect(rename.getByLabel("Team name")).toHaveAttribute("aria-invalid", "true");
  await bothThemes(page, "team rename refused");
  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: TEAM })).toBeVisible();
  await expect(main(page).getByText("In use")).toBeVisible();

  const member = form(page, "Add a member");
  await chooseByName(member.getByLabel("Member of staff"), "Cat Carer");
  await fillDate(member, "Joins from", 0);
  await member.getByRole("button", { name: "Add member" }).click();
  await done(page, "The member is added.");

  await chooseByName(form(page, "Add a member").getByLabel("Member of staff"), "Nell Nurse");
  await form(page, "Add a member").getByLabel("They lead the team").check();
  await fillDate(form(page, "Add a member"), "Joins from", 0);
  await form(page, "Add a member").getByRole("button", { name: "Add member" }).click();
  await done(page, "The member is added.");
  const members = main(page).getByRole("region", { name: "Members" });
  await expect(members.getByText("Team lead", { exact: true })).toBeVisible();
  await bothThemes(page, "team with a lead");

  // The carer becomes the lead too, then leaves the team.
  await form(page, "Cat Carer as team lead")
    .getByRole("button", { name: "Make Cat Carer the team lead" })
    .click();
  await done(page, "Who leads the team is saved.");
  const leaves = form(page, "Cat Carer leaves the team");
  await fillDate(leaves, "Leaves from", 1);
  await leaves.getByRole("button", { name: "End Cat Carer's membership" }).click();
  await done(page, "The membership has ended.");
  await expect(members.getByText("Ended")).toBeVisible();

  // Archiving with the keyboard only: the confirmation, then the button.
  const archive = form(page, "Archive the team");
  await archive.getByLabel("I understand the lead loses access to this team's records").focus();
  await page.keyboard.press("Space");
  await page.keyboard.press("Tab");
  await expect(archive.getByRole("button", { name: "Archive team" })).toBeFocused();
  await page.keyboard.press("Enter");
  await done(page, "The team is archived.");
  await expect(main(page).getByText("Archived", { exact: true })).toBeVisible();
  await expect(form(page, "Add a member")).toHaveCount(0);
  await bothThemes(page, "team archived");
});

test("a home's manager sees teams and line managers read only", async ({ page }) => {
  await as(page, "manager");
  await page.goto("/workforce/teams");
  await expect(page.getByRole("heading", { level: 1, name: "Staff teams" })).toBeVisible();
  await expect(main(page).getByText("Only HR adds, changes and archives teams.")).toBeVisible();
  await expect(main(page).getByRole("button")).toHaveCount(0);
  await bothThemes(page, "staff teams, read only");

  await page.goto("/workforce/staff");
  await main(page).getByRole("link", { name: "Line manager for Cat Carer" }).first().click();
  await expect(main(page).getByText("Only HR changes line managers.")).toBeVisible();
  await expect(main(page).getByRole("button")).toHaveCount(0);
  await bothThemes(page, "line manager, read only");
});

test("a care worker is offered neither screen", async ({ page }) => {
  await as(page, "carer");
  await page.goto("/");
  await expect(nav(page).getByRole("link", { name: "Staff teams" })).toHaveCount(0);
  await page.goto("/workforce/teams");
  await expect(
    main(page).getByText("You do not have access to this. Ask your manager if you need it."),
  ).toBeVisible();
  await bothThemes(page, "staff teams, no access");
});
