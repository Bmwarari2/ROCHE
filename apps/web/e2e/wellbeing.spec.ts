import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import { expectAccessible, signIn } from "./support";

/**
 * Phase 2 slice 61: the staff wellbeing screens (SCHED-011; scheduling.md section 16) against the
 * demo tenant.
 * - The manager (scheduling.wellbeing.manage) writes a survey for Harbour House and opens it.
 * - The carer (scheduling.wellbeing.self) answers it anonymously, keeps a private check-in, then
 *   shares it, and thanks the manager.
 * - The manager sees the shared check-in and the thanks by name, closes the survey, and is told
 *   that fewer people answered than the minimum group size, with no count.
 * The carer is given a staff file first (only members with one may answer). Every state is checked
 * with axe.
 */

const API_URL = process.env.API_URL ?? "http://localhost:4000";
const DEMO_TENANT = "0194d000-0000-7000-8000-000000000001";
const DEMO_LOCATION = "0194d000-0000-7000-8000-000000000101";
const RUN = `run ${Date.now().toString(36)}`;

const sessions: Record<string, Awaited<ReturnType<BrowserContext["cookies"]>>> = {};

test.beforeAll(async ({ browser }, testInfo) => {
  test.setTimeout(300_000);
  const headers = { "x-harbour-tenant": DEMO_TENANT };
  let carerId = "";
  for (const user of ["carer", "manager"]) {
    const context = await browser.newContext({ baseURL: testInfo.project.use.baseURL });
    await signIn(await context.newPage(), `${user}@example.invalid`);
    sessions[user] = await context.cookies();
    if (user === "carer") {
      const me = (await (await context.request.get(`${API_URL}/v1/me`, { headers })).json()) as {
        tenantUserId: string;
      };
      carerId = me.tenantUserId;
    } else {
      // Only members with a staff file made before a survey opens may answer it (rule 2). A file
      // left by an earlier attempt is refused as a second one, which is as good.
      await context.request.post(`${API_URL}/v1/workforce/staff-files`, {
        headers,
        data: {
          tenantUserId: carerId,
          locationId: DEMO_LOCATION,
          jobTitle: "Care worker",
          pathwayCategory: null,
          registrationBody: null,
          previousCareWork: true,
          dateOfBirth: null,
          startsOn: "2026-09-01",
          leftOn: null,
        },
      });
    }
    await context.close();
  }
});

async function as(context: BrowserContext, user: string) {
  await context.clearCookies();
  await context.addCookies(sessions[user] ?? []);
}

/** Today in the UK, as the date boxes ask for it. */
function todayParts(): Record<"day" | "month" | "year", string> {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/London",
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    })
      .formatToParts(new Date())
      .map((p) => [p.type, p.value]),
  );
  return { day: parts.day ?? "", month: parts.month ?? "", year: parts.year ?? "" };
}

async function fillDate(page: Page, legend: string) {
  const group = page.getByRole("group", { name: legend });
  const parts = todayParts();
  await group.getByLabel("Day", { exact: true }).fill(parts.day);
  await group.getByLabel("Month", { exact: true }).fill(parts.month);
  await group.getByLabel("Year", { exact: true }).fill(parts.year);
}

const arrival = (page: Page) => page.locator("[data-arrival-notice]");

test("SCHED-011 a survey is written, answered anonymously and closed below the size; check-ins and thanks", async ({
  context,
  page,
}) => {
  test.setTimeout(180_000);
  const title = `Autumn pulse ${RUN}`;

  await as(context, "manager");
  await page.goto("/wellbeing/surveys/new");
  await expect(page.getByRole("heading", { level: 1, name: "Write a survey" })).toBeVisible();
  await expectAccessible(page, "wellbeing survey form");
  // Every problem is listed at once before anything is sent.
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText("Choose who is asked");
  await expectAccessible(page, "wellbeing survey form refused");
  await page.getByLabel("Who is asked?").selectOption({ label: "Harbour House" });
  await page.getByLabel("Title").fill(title);
  await fillDate(page, "Opens on");
  await fillDate(page, "Closes after");
  const q1 = page.getByRole("group", { name: "Question 1", exact: true });
  await q1.getByLabel("Question", { exact: true }).fill("I feel supported at work");
  await page.getByRole("button", { name: "Add a question" }).click();
  const q2 = page.getByRole("group", { name: "Question 2", exact: true });
  await expect(q2.getByLabel("Question", { exact: true })).toBeFocused();
  await q2.getByLabel("Question", { exact: true }).fill("What would help you most?");
  await q2.getByRole("radio", { name: "Written words" }).check();
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(arrival(page)).toBeFocused();
  await expect(arrival(page)).toContainText("Draft saved");
  await page.getByRole("button", { name: "Open survey" }).click();
  await expect(page.getByRole("button", { name: "Keep as draft" })).toBeFocused();
  await expectAccessible(page, "wellbeing open question");
  await page.getByRole("button", { name: "Open survey" }).click();
  await expect(arrival(page)).toBeFocused();
  await expect(arrival(page)).toContainText("Survey opened");
  const surveyUrl = page.url().split("?")[0] ?? "";

  await as(context, "carer");
  await page.goto("/wellbeing");
  await expect(page.getByRole("heading", { level: 1, name: "Wellbeing" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Staff surveys" })).toHaveCount(0);
  await expectAccessible(page, "wellbeing member");
  await page.getByRole("link", { name: new RegExp(title) }).click();
  await expect(page.getByText("What is not recorded")).toBeVisible();
  await expect(page.getByText("When you answered.")).toBeVisible();
  await expectAccessible(page, "wellbeing answer");
  await page.getByRole("radio", { name: "4" }).check();
  await page.getByLabel(/What would help you most/).fill("More time to talk at handover.");
  await page.getByRole("button", { name: "Send my answers" }).click();
  await expect(arrival(page)).toBeFocused();
  await expect(arrival(page)).toContainText("Your answers were sent");
  await expect(page.getByRole("link", { name: new RegExp(title) })).toHaveCount(0);

  // A private check-in, then shared.
  await page.getByRole("radio", { name: "Okay" }).check();
  await page.getByLabel("Note (optional)").fill(`A long week (${RUN}).`);
  await page.getByRole("button", { name: "Save check-in" }).click();
  await expect(page.getByText("Check-in saved")).toBeVisible();
  const mine = page.getByRole("listitem").filter({ hasText: `A long week (${RUN}).` });
  await expect(mine.getByText("Private")).toBeVisible();
  await mine.getByRole("button", { name: "Share with my manager" }).click();
  await expect(mine.getByRole("status")).toHaveText(/Shared with your manager/);
  await expect(mine.getByText("Private")).toHaveCount(0);

  await page.getByLabel("Colleague", { exact: true }).selectOption({ label: "Mo Manager" });
  await page.getByLabel("Your note").fill(`Thank you for covering on Sunday (${RUN}).`);
  await page.getByRole("button", { name: "Send thanks" }).click();
  await expect(page.getByText("Thanks sent")).toBeVisible();
  await expectAccessible(page, "wellbeing member after");

  await as(context, "manager");
  await page.goto("/wellbeing/team");
  await expect(page.getByText(`A long week (${RUN}).`)).toBeVisible();
  await expect(page.getByText(/Cat Carer, .*: Okay/).first()).toBeVisible();
  await expect(page.getByText(`Thank you for covering on Sunday (${RUN}).`)).toBeVisible();
  await expectAccessible(page, "wellbeing team");

  await page.goto(surveyUrl);
  await page.getByRole("button", { name: "Close survey" }).click();
  await page.getByRole("button", { name: "Close survey" }).click();
  await expect(arrival(page)).toBeFocused();
  await expect(arrival(page)).toContainText("Survey closed");
  // One answer is below the minimum group size: said in words, with no count or text.
  await expect(page.getByText(/^Fewer than \d+ people answered/)).toBeVisible();
  await expect(page.getByText("More time to talk at handover.")).toHaveCount(0);
  await expectAccessible(page, "wellbeing results hidden");
});

test("SCHED-011 the carer cannot open the manager's pages", async ({ context, page }) => {
  await as(context, "carer");
  for (const path of ["/wellbeing/surveys", "/wellbeing/surveys/new", "/wellbeing/team"]) {
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.getByRole("button", { name: /Save draft|Open survey/ })).toHaveCount(0);
  }
});
