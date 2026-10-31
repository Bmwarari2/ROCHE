import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import { expectAccessible, signIn, signInWithDemoPasskey } from "./support";

/**
 * The weekly break-glass report (PLAT-006; people.md rule 14; hazard HZ-011) against the demo
 * tenant. The demo manager, who works at Harbour House, opens a Harbour Mews resident's record by
 * break-glass (with a fresh step-up: the end-to-end passkey). The worker's job then runs once as
 * if the week had ended (`break-glass-report:run --this-week`), so this week is reported. The
 * owner, who reads the report across the organisation, finds the Mews report, sees the manager and
 * the resident named, with the resident's communication needs, and records the review once; the
 * manager, whose access reaches Harbour House only, is not shown the Mews report; a care worker is
 * offered no report at all. A week is reported once, so a second run finds the report as the first
 * left it (reviewed). Every state is checked with axe in the light and dark themes.
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

/** The Monday of this UK week, as yyyy-mm-dd: the week the journey's report covers. */
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

async function bothThemes(page: Page, name: string) {
  await page.emulateMedia({ colorScheme: "light" });
  await expectAccessible(page, name);
  await page.emulateMedia({ colorScheme: "dark" });
  await expectAccessible(page, `${name}, dark theme`);
  await page.emulateMedia({ colorScheme: "light" });
}

test("a care worker is offered no break-glass report", async ({ page }) => {
  await signIn(page, "carer@example.invalid");
  await expect(nav(page).getByRole("link", { name: "Break-glass report" })).toHaveCount(0);
  await page.goto(PAGE);
  await expect(main(page)).toContainText("You do not have access to this");
  await bothThemes(page, "break-glass report refused");
});

test("hazard HZ-011 break-glass use is reported weekly, named, and reviewed once", async ({
  browser,
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  // The manager opens a record outside their access, with a fresh step-up.
  await signInWithDemoPasskey(page);
  await page.goto(`/people/${MEWS_TWIN}`);
  const opener = page.getByRole("button", { name: "Open a record outside your access" });
  const record = page.getByRole("heading", { level: 1, name: /Sam/ });
  // A run in the last hour may have left the record open (break-glass lapses after an hour).
  await expect(opener.or(record)).toBeVisible();
  if (await opener.isVisible()) {
    await opener.click();
    const sheet = page.getByRole("dialog", { name: "Open a record outside your access" });
    await sheet
      .getByLabel("Reason")
      .fill("Covering an emergency at Harbour Mews tonight while its manager is away");
    await sheet.getByRole("button", { name: "Open record" }).click();
  }
  await expect(record).toBeVisible();

  // The Monday job, run as if this week had ended.
  execFileSync("pnpm", ["break-glass-report:run", "--this-week"], {
    cwd: API_DIR,
    stdio: "ignore",
  });
  const week = thisMonday();

  // The manager reads reports for Harbour House only: the Mews report is not theirs.
  await page.goto(`${PAGE}?week=${week}`);
  await expect(
    page.getByRole("heading", { level: 1, name: "Weekly break-glass report" }),
  ).toBeVisible();
  await expect(main(page).getByRole("link", { name: "Harbour Mews" })).toHaveCount(0);

  // The owner reads every location's report.
  const owner = await browser.newContext({ baseURL: testInfo.project.use.baseURL });
  const ownerPage = await owner.newPage();
  await signIn(ownerPage, "owner@example.invalid");
  await nav(ownerPage).getByRole("link", { name: "Break-glass report" }).click();
  await expect(
    ownerPage.getByRole("heading", { level: 1, name: "Weekly break-glass report" }),
  ).toBeVisible();
  await bothThemes(ownerPage, "break-glass reports, last week");

  // An old week has no reports, and says so in words.
  await ownerPage.goto(`${PAGE}?week=2020-01-06`);
  await expect(main(ownerPage)).toContainText("No reports for this week");
  await bothThemes(ownerPage, "break-glass reports, none");

  await ownerPage.goto(`${PAGE}?week=${week}`);
  const mews = main(ownerPage).getByRole("listitem").filter({ hasText: "Harbour Mews" });
  await expect(mews).toContainText(/records? opened by/);
  await expect(mews.getByText(/^(Reviewed|To review)$/)).toBeVisible();
  await bothThemes(ownerPage, "break-glass reports, this week");

  await mews.getByRole("link", { name: "Harbour Mews" }).click();
  await expect(
    ownerPage.getByRole("heading", { level: 1, name: "Weekly break-glass report" }),
  ).toBeVisible();
  const opened = ownerPage.getByRole("region", { name: "Records opened" });
  await expect(
    opened.getByRole("table", { name: "Records opened, by member of staff" }),
  ).toContainText("Mo Manager");
  // The owner supports everyone, so every person is named, never numbered.
  const byPerson = opened.getByRole("table", { name: "Records opened, by person" });
  await expect(byPerson).toContainText(/Sam Twin|Una Example/);
  await expect(byPerson).not.toContainText("not shown to you");
  // Communication needs beside each person named (AIS), in every state.
  const needs = opened.getByRole("list", { name: "Communication needs of the people named" });
  await expect(needs.getByRole("listitem").first()).toContainText("Communication needs");
  await expect(main(ownerPage)).toContainText("kept in the audit log");
  // The report holds counts and names, never the reason typed.
  await expect(main(ownerPage)).not.toContainText("Covering an emergency");
  await bothThemes(ownerPage, "break-glass report for Harbour Mews");

  const review = ownerPage.getByRole("region", { name: "Review" });
  if ((await review.getByRole("button", { name: "Record the review" }).count()) > 0) {
    // Too short first: said at the field, nothing sent.
    await review.getByLabel("Actions taken").fill("ok");
    await review.getByRole("button", { name: "Record the review" }).click();
    await expect(review.getByRole("alert")).toContainText("3 characters or more");
    await bothThemes(ownerPage, "break-glass review refused");
    await review
      .getByLabel("Actions taken")
      .fill("Spoke to the manager about covering the Mews; access to be widened for cover shifts.");
    await review.getByRole("button", { name: "Record the review" }).click();
    await expect(
      ownerPage.getByRole("heading", { level: 1, name: "Weekly break-glass report" }),
    ).toBeFocused();
    await expect(main(ownerPage).getByRole("status")).toContainText("Review recorded");
  }
  await expect(review).toContainText("Reviewed by Olive Owner");
  await expect(review.getByRole("button", { name: "Record the review" })).toHaveCount(0);
  await expect(main(ownerPage).getByText("Reviewed", { exact: true })).toBeVisible();
  await bothThemes(ownerPage, "break-glass report reviewed");
  await owner.close();
});
