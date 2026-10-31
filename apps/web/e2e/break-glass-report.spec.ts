import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { expectAccessible, signIn, signInWithDemoPasskey } from "./support";

/**
 * The weekly break-glass report (PLAT-006; people.md rule 14; hazard HZ-011) against the demo
 * tenant, with axe in the light and dark themes on every state.
 *
 * - A care worker is offered no report.
 * - The demo manager, who works at Harbour House, opens a Harbour Mews resident's record by
 *   break-glass (a fresh step-up with the end-to-end passkey); the worker's job then runs as if the
 *   week had ended (`break-glass-report:run --this-week`). The owner, across the organisation,
 *   finds the Mews report naming the manager; the manager, whose access reaches Harbour House
 *   only, is not shown it.
 * - For an unused past week, the job runs after giving the week an invented opening by the
 *   manager and break-glass search by the owner at Harbour Mews (`--e2e-week`), so every run
 *   finds fresh reports: the owner may not review the Mews report, which counts their search, and
 *   reviews Harbour House's by keyboard alone, once.
 */

/**
 * One of the two invented Sam Twins at Harbour Mews (apps/api/scripts/seed-users.ts), not Una
 * Example: break-glass stays open for an hour, and break-glass.spec.ts needs Una's record closed
 * to the manager when it starts.
 */
const MEWS_TWIN = "0194d000-0000-7000-8600-000000000152";

const API_DIR = fileURLToPath(new URL("../../api", import.meta.url));
const PAGE = "/break-glass/weekly-report";

test.describe.configure({ mode: "serial" });

const main = (page: Page) => page.getByRole("main");
const nav = (page: Page) => page.getByRole("navigation", { name: "Modules" });
const heading = (page: Page, name: string | RegExp) =>
  page.getByRole("heading", { level: 1, name });

/** The report job, once; returns how many reports it stored. */
function runReport(...args: string[]): number {
  const out = execFileSync("pnpm", ["--silent", "break-glass-report:run", ...args], {
    cwd: API_DIR,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return Number(/reports stored: (\d+)/.exec(out)?.[1] ?? "0");
}

/** The Monday of this UK week, as yyyy-mm-dd. */
function thisMonday(now = new Date()): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/London",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      weekday: "short",
    })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  const back = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(parts.weekday ?? "");
  const date = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)));
  date.setUTCDate(date.getUTCDate() - back);
  return date.toISOString().slice(0, 10);
}

/**
 * A past week no run has reported yet, reported now with the invented opening and search: a
 * Monday between 2000 and 2024 picked from the clock, tried again if a run already used it.
 */
function freshReportedWeek(): string {
  for (let attempt = 0; attempt < 10; attempt++) {
    const weeks = (Math.floor(Date.now() / 1000) + attempt * 97) % 1300;
    const monday = new Date(Date.UTC(2000, 0, 3 + weeks * 7)).toISOString().slice(0, 10);
    if (runReport(`--e2e-week=${monday}`) > 0) return monday;
  }
  throw new Error("No unused week found for the break-glass report journey");
}

async function bothThemes(page: Page, name: string) {
  await page.emulateMedia({ colorScheme: "light" });
  await expectAccessible(page, name);
  await page.emulateMedia({ colorScheme: "dark" });
  await expectAccessible(page, `${name}, dark theme`);
  await page.emulateMedia({ colorScheme: "light" });
}

/** Presses Tab (or Shift+Tab) until the control has focus, as a keyboard user would. */
async function tabTo(page: Page, target: Locator, backwards = false) {
  for (let presses = 0; presses < 120; presses++) {
    if (await target.evaluate((el) => el === document.activeElement)) return;
    await page.keyboard.press(backwards ? "Shift+Tab" : "Tab");
  }
  throw new Error("The control was never reached by keyboard");
}

test("a care worker is offered no break-glass report", async ({ page }) => {
  await signIn(page, "carer@example.invalid");
  await expect(nav(page).getByRole("link", { name: "Break-glass report" })).toHaveCount(0);
  await page.goto(PAGE);
  await expect(main(page)).toContainText("You do not have access to this");
  await bothThemes(page, "break-glass report refused");
});

test("hazard HZ-011 break-glass use is reported weekly and named, to the locations it concerns", async ({
  browser,
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  // The manager opens a record outside their access, with a fresh step-up.
  await signInWithDemoPasskey(page);
  await page.goto(`/people/${MEWS_TWIN}`);
  const opener = page.getByRole("button", { name: "Open a record outside your access" });
  const record = heading(page, /Sam/);
  // A run in the last hour may have left the record open (break-glass lapses after an hour).
  await expect(opener.or(record)).toBeVisible();
  if (await opener.isVisible()) {
    await opener.click();
    const sheet = page.getByRole("dialog", { name: "Open a record outside your access" });
    await sheet.getByLabel("Why you need this record").selectOption("emergency_care");
    await sheet
      .getByLabel("Explain in your own words")
      .fill("Covering an emergency at Harbour Mews tonight while its manager is away");
    await sheet.getByRole("button", { name: "Open record" }).click();
  }
  await expect(record).toBeVisible();

  runReport("--this-week");
  const week = thisMonday();

  // The manager reads reports for Harbour House only: the Mews report is not theirs.
  await page.goto(`${PAGE}?week=${week}`);
  await expect(heading(page, "Weekly break-glass report")).toBeVisible();
  await expect(main(page).getByRole("link", { name: "Harbour Mews" })).toHaveCount(0);
  await expect(main(page).getByRole("link", { name: "Harbour House" })).toBeVisible();

  // The owner reads every location's report.
  const owner = await browser.newContext({ baseURL: testInfo.project.use.baseURL });
  const ownerPage = await owner.newPage();
  await signIn(ownerPage, "owner@example.invalid");
  await nav(ownerPage).getByRole("link", { name: "Break-glass report" }).click();
  await expect(heading(ownerPage, "Weekly break-glass report")).toBeVisible();
  await bothThemes(ownerPage, "break-glass reports, last week");

  // An old week has no reports, and says so in words.
  await ownerPage.goto(`${PAGE}?week=1990-01-01`);
  await expect(main(ownerPage)).toContainText("No reports for this week");
  await bothThemes(ownerPage, "break-glass reports, none");

  await ownerPage.goto(`${PAGE}?week=${week}`);
  const mews = main(ownerPage).getByRole("listitem").filter({ hasText: "Harbour Mews" });
  await expect(mews).toContainText(/records? opened by/);
  await mews.getByRole("link", { name: "Harbour Mews" }).click();
  await expect(heading(ownerPage, "Break-glass report for Harbour Mews")).toBeVisible();
  const opened = ownerPage.getByRole("region", { name: "Records opened" });
  await expect(
    opened.getByRole("table", { name: "Records opened, by member of staff" }),
  ).toContainText("Mo Manager");
  // The report holds counts and names, never the reason typed.
  await expect(main(ownerPage)).not.toContainText("Covering an emergency");
  await bothThemes(ownerPage, "this week's break-glass report for Harbour Mews");
  await owner.close();
});

test("hazard HZ-011 a report is reviewed once, by keyboard, and never by someone it counts", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const week = freshReportedWeek();
  await signIn(page, "owner@example.invalid");
  await page.goto(`${PAGE}?week=${week}`);
  await expect(heading(page, "Weekly break-glass report")).toBeVisible();
  const house = main(page).getByRole("listitem").filter({ hasText: "Harbour House" });
  const mews = main(page).getByRole("listitem").filter({ hasText: "Harbour Mews" });
  await expect(house.getByText("To review", { exact: true })).toBeVisible();
  await expect(mews.getByText("To review", { exact: true })).toBeVisible();
  await expect(mews).toContainText("1 record opened by 1 member of staff, about 1 person");
  // Across the organisation, the searches that showed no one at any location (none this week).
  await expect(
    page.getByRole("region", { name: "Searches that showed no one at any location" }),
  ).toContainText("There were no such searches this week.");
  await bothThemes(page, "break-glass reports, a fresh week");

  // The Mews report counts the owner's search: someone else must review it.
  await tabTo(page, mews.getByRole("link", { name: "Harbour Mews" }));
  await page.keyboard.press("Enter");
  await expect(heading(page, "Break-glass report for Harbour Mews")).toBeVisible();
  await expect(page).toHaveTitle(
    /^Break-glass report for Harbour Mews, week of \d{2}\/\d{2}\/\d{4}/,
  );
  const review = page.getByRole("region", { name: "Review" });
  await expect(review).toContainText(
    "This report counts your own use of break-glass access, so someone else must review it.",
  );
  await expect(review.getByRole("button", { name: "Record the review" })).toHaveCount(0);
  const opened = page.getByRole("region", { name: "Records opened" });
  await expect(opened.getByRole("table", { name: "Records opened, by person" })).toContainText(
    "Sam Twin",
  );
  // Communication needs beside each person named (AIS).
  await expect(
    opened
      .getByRole("list", { name: "Communication needs of the people named" })
      .getByRole("listitem")
      .first(),
  ).toContainText("Communication needs");
  await expect(
    page.getByRole("region", { name: "Break-glass searches" }).getByRole("table").first(),
  ).toContainText("Olive Owner");
  await expect(page.getByRole("region", { name: "Needs your attention" })).toContainText(
    "Nothing was flagged this week.",
  );
  await bothThemes(page, "break-glass report the owner may not review");

  // A table sorts by keyboard.
  const staffTable = opened.getByRole("table", { name: "Records opened, by member of staff" });
  const column = staffTable.getByRole("columnheader", { name: /Records opened/ });
  await expect(column).not.toHaveAttribute("aria-sort", /.+/);
  await tabTo(page, column.getByRole("button"));
  await page.keyboard.press("Enter");
  await expect(column).toHaveAttribute("aria-sort", /ascending|descending/);

  // Back to the list by the breadcrumb, then into Harbour House's report.
  await tabTo(page, page.getByRole("navigation", { name: "Breadcrumb" }).getByRole("link"), true);
  await page.keyboard.press("Enter");
  await expect(heading(page, "Weekly break-glass report")).toBeVisible();
  await tabTo(page, house.getByRole("link", { name: "Harbour House" }));
  await page.keyboard.press("Enter");
  await expect(heading(page, "Break-glass report for Harbour House")).toBeVisible();
  await expect(main(page)).toContainText(
    "No records were opened with break-glass access this week.",
  );

  // Too short first: said in a summary that takes focus and links to the field.
  const houseReview = page.getByRole("region", { name: "Review" });
  const actions = houseReview.getByLabel("Actions taken");
  await tabTo(page, actions);
  await page.keyboard.type("ok");
  await page.keyboard.press("Tab");
  await expect(houseReview.getByRole("button", { name: "Record the review" })).toBeFocused();
  await page.keyboard.press("Enter");
  const problem = houseReview.getByRole("alert");
  await expect(problem).toContainText("Enter what you did, using at least 3 characters");
  await bothThemes(page, "break-glass review refused");
  await tabTo(page, problem.getByRole("link"));
  await page.keyboard.press("Enter");
  await expect(actions).toBeFocused();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type(
    "Checked the week with the deputy manager; no break-glass use to follow up.",
  );
  await page.keyboard.press("Tab");
  await page.keyboard.press("Enter");

  await expect(heading(page, "Break-glass report for Harbour House")).toBeFocused();
  await expect(main(page).getByRole("status")).toContainText("Review recorded");
  await expect(houseReview).toContainText("Reviewed by Olive Owner");
  await expect(houseReview).toContainText("no break-glass use to follow up");
  await expect(houseReview.getByRole("button", { name: "Record the review" })).toHaveCount(0);
  await expect(main(page).getByText("Reviewed", { exact: true })).toBeVisible();
  await bothThemes(page, "break-glass report reviewed");
});
