import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import { demoPerson, expectAccessible, signIn } from "./support";

/**
 * Review scheduling on the web (PEOP-008; people.md rule 8 and section 6a; HZ-008) against the
 * demo tenant, as the demo nurse (clinical lead: care.plan.read and care.plan.write). Each run
 * records its own change and reviews for Dev (resident 4), marked with the run, and reads only
 * what it recorded; review records are append-only, so earlier runs' records stay and do not
 * matter.
 */

const PERSON = demoPerson(4);
const RUN = `run ${Date.now().toString(36)}`;

test.describe.configure({ mode: "serial" });

let session: Awaited<ReturnType<BrowserContext["cookies"]>> = [];

test.beforeAll(async ({ browser }, testInfo) => {
  const context = await browser.newContext({ baseURL: testInfo.project.use.baseURL });
  const page = await context.newPage();
  await signIn(page, "nurse@example.invalid");
  session = await context.cookies();
  await context.close();
});

test.beforeEach(async ({ context }) => {
  await context.addCookies(session);
});

const card = (page: Page, title: string) => page.getByRole("region", { name: title });

async function bothThemes(page: Page, name: string) {
  await expectAccessible(page, name);
  await page.emulateMedia({ colorScheme: "dark" });
  await expectAccessible(page, `${name}, dark theme`);
  await page.emulateMedia({ colorScheme: "light" });
}

test("the reviews tab shows when each review is due, as an icon and a word, and passes axe", async ({
  page,
}) => {
  await page.goto(`/people/${PERSON}/reviews`);
  await expect(page.getByRole("heading", { level: 1, name: "Dev Fixture" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Reviews", exact: true })).toHaveAttribute(
    "aria-current",
    "page",
  );
  const due = card(page, "When reviews are due");
  await expect(due).toBeVisible();
  // Every state is said in words beside its icon, never by colour alone.
  for (const chip of await due.locator("[data-status]").all()) {
    await expect(chip).toHaveText(/Overdue|Due|Upcoming|Paused while in hospital/);
  }
  await expect(
    due.getByText(/^Worked out from your organisation's settings: /).first(),
  ).toBeVisible();
  await bothThemes(page, "reviews tab");
});

test("hazard HZ-008 a change in need brings the care plan review forward, and the tracker lists it", async ({
  page,
}) => {
  await page.goto(`/people/${PERSON}/reviews`);
  const change = card(page, "Record a change in need");
  await change.getByLabel("What changed").selectOption("fall");
  await change.getByRole("button", { name: "Record the change" }).click();
  await expect(page.getByText("Change recorded. A care plan review is now due.")).toBeVisible();

  const waiting = card(page, "Changes waiting for review");
  await expect(
    waiting.locator("[data-care-plan-change]").filter({ hasText: "Fall" }).first(),
  ).toBeVisible();
  const onChange = card(page, "When reviews are due").locator(
    '[data-review-kind="care_plan_review_on_change"]',
  );
  await expect(onChange).toContainText("Care plan review after a change");
  await expect(onChange.locator("[data-status]")).toHaveText(/Due|Overdue/);

  // The manager's tracker names the person, links to their reviews and says the state in words.
  await page.goto("/people");
  await page.getByRole("link", { name: "Reviews due" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Reviews due" })).toBeVisible();
  const row = page
    .getByRole("row")
    .filter({ hasText: "Dev Fixture" })
    .filter({ hasText: "Care plan review after a change" });
  await expect(row).toBeVisible();
  // The state as an icon and a word; the person's communication needs beside their name (AIS).
  await expect(row.locator("[data-status]").filter({ hasText: /^(Due|Overdue)$/ })).toHaveCount(1);
  await expect(row.getByRole("cell").last()).not.toBeEmpty();
  await bothThemes(page, "reviews due tracker");
  await row.getByRole("link", { name: "Dev Fixture" }).click();
  await expect(page).toHaveURL(new RegExp(`/people/${PERSON}/reviews$`));

  // One care plan review covers every change waiting for it (HZ-008).
  const form = card(page, "Record a review");
  await form.getByLabel("Kind of review").selectOption("care_plan");
  await form.getByLabel("Who took part (optional)").fill("Key worker\nSocial worker");
  await form.getByLabel("Outcome (optional)").fill(`Plan updated after the fall (${RUN})`);
  await form.getByRole("button", { name: "Record the review" }).click();
  await expect(page.getByText("Review recorded.")).toBeVisible();
  await expect(card(page, "Changes waiting for review")).toContainText(
    "No changes are waiting for review.",
  );
  const record = card(page, "Reviews held")
    .locator('[data-review-record="care_plan"]')
    .filter({ hasText: RUN });
  await expect(record).toContainText("Who took part: Key worker, Social worker");
  await expect(record).toContainText(/Covered \d+ change/);
  await expect(
    card(page, "When reviews are due").locator('[data-review-kind="care_plan_review_on_change"]'),
  ).toHaveCount(0);
});

test("hazard HZ-008 a family involvement review asks how the family was involved", async ({
  page,
}) => {
  await page.goto(`/people/${PERSON}/reviews`);
  const form = card(page, "Record a review");
  await form.getByLabel("Kind of review").selectOption("family_involvement");
  await form.getByLabel("Outcome (optional)").fill(`Daughter's views added (${RUN})`);
  await form.getByRole("button", { name: "Record the review" }).click();
  // Refused before anything is sent, with the error at the question and in the summary.
  const alert = page.getByRole("alert").filter({ hasText: "Choose how the family" });
  await expect(alert).toBeFocused();
  await bothThemes(page, "reviews tab, family involvement error");
  await form.getByRole("radio", { name: "The family or representative contributed" }).check();
  await form.getByRole("button", { name: "Record the review" }).click();
  await expect(page.getByText("Review recorded.")).toBeVisible();
  await expect(
    card(page, "Reviews held")
      .locator('[data-review-record="family_involvement"]')
      .filter({ hasText: RUN }),
  ).toContainText("The family or representative contributed");
});
