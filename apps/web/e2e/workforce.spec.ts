import { type BrowserContext, expect, type Locator, type Page, test } from "@playwright/test";
import { expectAccessible, signIn, signInWithDemoPasskey } from "./support";

/**
 * The workforce screens (plan slice 58; WORK-001, WORK-004, WORK-010, WORK-013) against the demo
 * tenant. The owner adds a job template (refused in words first), opens a vacancy, adds an
 * invented applicant named with the run, shortlists them against the essential criteria and
 * records a values-based interview; then reads the staff list and the demo carer's induction and
 * leaving (their staff file is made through the API the first time). Employee
 * relations is a restricted silo (ADR-0089): the owner holds no casework role in the demo seed, so
 * the navigation never offers it and the cases screen shows no case and no way to open one. The
 * carer is offered none of the workforce screens and is refused each in words. Running a case
 * needs a casework holder, whom the demo seed does not have: the API tests cover it (H-936).
 * Every state is checked with axe.
 */

const API_URL = process.env.API_URL ?? "http://localhost:4000";
const TENANT = "0194d000-0000-7000-8000-000000000001";
/** The demo carer (packages/db/src/seed/demo.ts). */
const CARER = "0194d000-0000-7000-8000-000000000304";
const RUN = Date.now().toString(36);
const TEMPLATE = `Care worker ${RUN}`;
const VACANCY = `Night care worker ${RUN}`;
const GIVEN = "Ada";
const FAMILY = `Example${RUN}`;

test.describe.configure({ mode: "serial" });

const sessions: Record<string, Awaited<ReturnType<BrowserContext["cookies"]>>> = {};

test.beforeAll(async ({ browser }, testInfo) => {
  test.setTimeout(180_000);
  for (const user of ["owner", "carer"]) {
    const context = await browser.newContext({ baseURL: testInfo.project.use.baseURL });
    const page = await context.newPage();
    if (user === "owner") await signInWithDemoPasskey(page, "owner");
    else await signIn(page, `${user}@example.invalid`);
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

/** Today in the UK, as the API's dates are. */
const ukToday = () => {
  const [year, month, day] = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" })
    .format(new Date())
    .split("-");
  return { day: day ?? "", month: month ?? "", year: year ?? "" };
};

async function fillDate(group: Locator) {
  const today = ukToday();
  await group.getByLabel("Day", { exact: true }).fill(today.day);
  await group.getByLabel("Month", { exact: true }).fill(today.month);
  await group.getByLabel("Year", { exact: true }).fill(today.year);
}

test("the carer is offered no workforce screens and is refused each in words", async ({ page }) => {
  await as(page, "carer");
  await page.goto("/");
  for (const name of ["Vacancies", "Staff", "Employee relations"]) {
    await expect(nav(page).getByRole("link", { name, exact: true })).toHaveCount(0);
  }
  for (const path of ["/workforce/vacancies", "/workforce/job-templates", "/workforce/staff"]) {
    await page.goto(path);
    await expect(main(page)).toContainText("You do not have access to this");
  }
  await expectAccessible(page, "workforce refused");
});

test("employee relations stays a silo: the owner sees no case and no way in", async ({ page }) => {
  await as(page, "owner");
  await page.goto("/");
  await expect(nav(page).getByRole("link", { name: "Vacancies", exact: true })).toBeVisible();
  await expect(nav(page).getByRole("link", { name: "Staff", exact: true })).toBeVisible();
  await expect(nav(page).getByRole("link", { name: "Employee relations" })).toHaveCount(0);
  await page.goto("/workforce/cases");
  await expect(main(page)).toContainText("You are not named on any case");
  await expect(form(page, "Open a case")).toHaveCount(0);
  await expectAccessible(page, "no cases");
});

test("the owner adds a job template, with errors in words first", async ({ page }) => {
  await as(page, "owner");
  await page.goto("/workforce/job-templates");
  await expect(page.getByRole("heading", { level: 1, name: "Job templates" })).toBeVisible();
  const add = form(page, "Add a job template");
  await add.getByRole("button", { name: "Add template" }).click();
  await expect(main(page).getByRole("alert").first()).toBeVisible();
  await expect(add).toContainText("Job title is needed");
  await expectAccessible(page, "job template errors");

  await add.getByLabel("Job title").fill(TEMPLATE);
  await add.getByLabel("Care Workforce Pathway role").selectOption("care_worker");
  await add
    .getByLabel("Essential criteria")
    .fill("Can read and write English well enough to keep records\nWilling to work nights");
  await add
    .getByLabel("Values-based interview questions")
    .fill(
      "compassion: Tell us about a time you comforted someone.\ncourage: Tell us about a time you spoke up.",
    );
  await add.getByRole("button", { name: "Add template" }).click();
  await expect(main(page).getByRole("status").filter({ hasText: "added" })).toBeVisible();
  await expect(main(page).getByRole("heading", { level: 2, name: TEMPLATE })).toBeVisible();
  await expectAccessible(page, "job templates");
});

test("the owner opens a vacancy and adds an applicant", async ({ page }) => {
  await as(page, "owner");
  await page.goto("/workforce/vacancies");
  const add = form(page, "Add a vacancy");
  await add.getByLabel("Job template").selectOption({ label: TEMPLATE });
  await add.getByLabel("Vacancy title").fill(VACANCY);
  await fillDate(add.getByRole("group", { name: "Opening date" }));
  await add.getByLabel("Open it for applications now").check();
  await add.getByRole("button", { name: "Add vacancy" }).click();
  await expect(main(page).getByRole("link", { name: VACANCY })).toBeVisible();
  await expectAccessible(page, "vacancies");

  await main(page).getByRole("link", { name: VACANCY }).click();
  await expect(page.getByRole("heading", { level: 1, name: VACANCY })).toBeVisible();
  const apply = form(page, "Add an application");
  await apply.getByLabel("First name").fill(GIVEN);
  await apply.getByLabel("Last name").fill(FAMILY);
  await apply.getByLabel("Email address").fill(`applicant.${RUN}@example.invalid`);
  await apply.getByRole("button", { name: "Add application" }).click();
  const applicant = main(page).getByRole("link", { name: `${GIVEN} ${FAMILY}` });
  await expect(applicant).toBeVisible();
  // The stage is a word beside an icon, never a colour alone.
  await expect(
    main(page)
      .getByRole("listitem")
      .filter({ has: page.getByRole("link", { name: `${GIVEN} ${FAMILY}` }) })
      .getByText("Applied"),
  ).toBeVisible();
  // Equality counts appear only once the vacancy has closed (rule 12), never while it is open.
  await expect(main(page)).not.toContainText("Equality monitoring");
  await expect(form(page, "Change the vacancy's status").getByLabel("Status")).toHaveValue("open");
  await expectAccessible(page, "vacancy");
});

test("the owner shortlists the applicant and records an interview", async ({ page }) => {
  await as(page, "owner");
  await page.goto("/workforce/vacancies");
  await main(page).getByRole("link", { name: VACANCY }).click();
  await main(page)
    .getByRole("link", { name: `${GIVEN} ${FAMILY}` })
    .click();
  await expect(main(page).getByText("Applied").first()).toBeVisible();

  const shortlist = form(page, "Shortlisting");
  // Both criteria are met; wait for them before ticking, or none would be sent.
  await expect(shortlist.getByRole("checkbox")).toHaveCount(2);
  for (const box of await shortlist.getByRole("checkbox").all()) await box.check();
  await shortlist.getByRole("button", { name: "Save shortlisting" }).click();
  await expect(main(page).getByText("Shortlisted").first()).toBeVisible();
  await expectAccessible(page, "shortlisted");

  const interview = form(page, "Record an interview");
  await fillDate(interview.getByRole("group", { name: "Interview date" }));
  await interview.getByLabel("Panel member 1").selectOption({ index: 1 });
  await interview.getByLabel("Tell us about a time you comforted someone.").selectOption("3");
  await interview.getByLabel("Tell us about a time you spoke up.").selectOption("4");
  await interview.getByLabel("Panel's recommendation").selectOption("proceed");
  await interview.getByRole("button", { name: "Record interview" }).click();
  await expect(main(page)).toContainText("Scores 7 out of 8");
  await expect(main(page).getByText("Interviewed").first()).toBeVisible();
  await expectAccessible(page, "interviewed");
});

test("the owner reads the staff list, a member's induction and their leaving", async ({ page }) => {
  await as(page, "owner");
  // The demo carer's staff file, made once through the API (409 when an earlier run made it).
  const made = await page.request.post(`${API_URL}/v1/workforce/staff-files`, {
    headers: { "x-harbour-tenant": TENANT },
    data: {
      tenantUserId: CARER,
      locationId: null,
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
  await expect(page.getByRole("heading", { level: 1, name: "Staff" })).toBeVisible();
  await expectAccessible(page, "staff");
  await main(page)
    .getByRole("link", { name: /^Induction for / })
    .first()
    .click();
  await expect(page.getByRole("heading", { level: 1, name: /^Induction: / })).toBeVisible();
  await expect(main(page).getByRole("heading", { name: "Induction checklist" })).toBeVisible();
  // Each checklist item's status is a word beside an icon.
  await expect(main(page).getByText("To do").first()).toBeVisible();
  await expectAccessible(page, "induction");

  await page.goto("/workforce/staff");
  await main(page)
    .getByRole("link", { name: /^Leaving for / })
    .first()
    .click();
  await expect(page.getByRole("heading", { level: 1, name: /^Leaving: / })).toBeVisible();
  await expectAccessible(page, "leaving");
});
