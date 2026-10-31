import { expect, type Page, test } from "@playwright/test";
import { expectAccessible, signIn } from "./support";

/**
 * The compliance framework, evidence library and audit programme (QUAL-001, QUAL-002, QUAL-004;
 * quality.md section 20) against the demo tenant. The manager maps a quality statement and reads
 * coverage with its gaps and a statement's evidence; adds a medication audit template from the
 * starters, schedules it at Harbour House, starts an audit, answers it, completes it with an
 * action and a self-rating, and tags it as evidence; then starts a mock inspection. Every state
 * passes axe in the light and dark themes. Each run names its templates afresh, so re-runs never
 * depend on what earlier runs left.
 */

test.describe.configure({ mode: "serial" });

const RUN = Date.now().toString(36);
const main = (page: Page) => page.getByRole("main");

async function bothThemes(page: Page, name: string) {
  await page.emulateMedia({ colorScheme: "light" });
  await expectAccessible(page, name);
  await page.emulateMedia({ colorScheme: "dark" });
  await expectAccessible(page, `${name}, dark theme`);
  await page.emulateMedia({ colorScheme: "light" });
}

/** The arrival: focus on the page's heading, and a status saying what was done. */
async function arrived(page: Page, words: string | RegExp) {
  await expect(page.getByRole("heading", { level: 1 })).toBeFocused();
  await expect(main(page).getByRole("status").filter({ hasText: words })).toBeVisible();
}

/** Today in the three date boxes of a field. */
async function today(page: Page, legend: string) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    day: "numeric",
    month: "numeric",
    year: "numeric",
  }).formatToParts(new Date());
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const group = main(page).getByRole("group", { name: legend });
  await group.getByRole("textbox", { name: "Day" }).fill(get("day"));
  await group.getByRole("textbox", { name: "Month" }).fill(get("month"));
  await group.getByRole("textbox", { name: "Year" }).fill(get("year"));
}

test("the manager maps a quality statement and reads coverage with its gaps", async ({ page }) => {
  test.setTimeout(180_000);
  await signIn(page, "manager@example.invalid");
  await page.getByRole("link", { name: "Framework and evidence" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Compliance framework" })).toBeVisible();
  await expect(main(page).getByText("In force", { exact: true })).toBeVisible();
  await bothThemes(page, "framework versions");

  await main(page)
    .getByRole("link", { name: "CQC single assessment framework, version 1" })
    .click();
  await expect(main(page).getByRole("heading", { name: "Your mapping" })).toBeVisible();
  await bothThemes(page, "framework version and mapping");

  const statement = main(page).getByRole("group", { name: "Learning culture" });
  await statement
    .getByLabel("Your title for Learning culture")
    .fill(`Learning from incidents ${RUN}`);
  await statement.getByLabel("Owner role for Learning culture").fill("Registered Manager");
  await statement.getByRole("checkbox").first().check();
  await main(page).getByRole("button", { name: "Save mapping" }).click();
  await arrived(page, "Mapping saved as a new version.");
  await expect(main(page).getByLabel("Your title for Learning culture")).toHaveValue(
    `Learning from incidents ${RUN}`,
  );
  await bothThemes(page, "mapping saved");

  await main(page).getByRole("link", { name: "View evidence coverage" }).click();
  await expect(page).toHaveTitle(/^Evidence coverage/);
  await expect(main(page).getByText(/have no evidence|Every statement has evidence/)).toBeVisible();
  await expect(main(page).getByText("No evidence").first()).toBeVisible();
  await bothThemes(page, "evidence coverage");

  await main(page).getByRole("link", { name: "Safeguarding" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Safeguarding" })).toBeVisible();
  await bothThemes(page, "a statement's evidence");
});

test("the manager runs an audit from a starter to completion and tags it as evidence", async ({
  page,
}) => {
  test.setTimeout(240_000);
  await signIn(page, "manager@example.invalid");
  await page.goto("/quality/audits/templates");
  await bothThemes(page, "audit templates");

  // Refused in words at the field, then added from the medication starter.
  await main(page).getByRole("button", { name: "Add template" }).click();
  await expect(main(page).getByText("Choose a starter template").first()).toBeVisible();
  await bothThemes(page, "template refused");
  await main(page)
    .getByLabel("Starter template", { exact: true })
    .selectOption({ label: "Medication audit" });
  await main(page).getByLabel("Short name", { exact: true }).fill(`medication-${RUN}`);
  await main(page).getByRole("button", { name: "Add template" }).click();
  await arrived(page, "Template added.");
  await expect(main(page).getByRole("heading", { name: "Questions" })).toBeVisible();
  await bothThemes(page, "template added");

  // Scheduled at Harbour House, first due today.
  await main(page).getByLabel("Location", { exact: true }).selectOption({ label: "Harbour House" });
  await main(page).getByLabel("Every how many months", { exact: true }).fill("3");
  await today(page, "First due date");
  await main(page).getByRole("button", { name: "Schedule audit" }).click();
  await arrived(page, "Audit scheduled.");
  await expect(main(page).getByText(/^Due /).first()).toBeVisible();
  await bothThemes(page, "template scheduled");

  // Started at Harbour House today.
  await page.goto("/quality/audits/new");
  await bothThemes(page, "start an audit");
  await main(page)
    .getByLabel("Template", { exact: true })
    .selectOption({ label: "Medication audit (audit)" });
  await main(page).getByLabel("Location", { exact: true }).selectOption({ label: "Harbour House" });
  await main(page).getByRole("button", { name: "Start audit" }).click();
  await arrived(page, "Audit started.");
  await expect(main(page).getByText("In progress").first()).toBeVisible();
  await bothThemes(page, "audit in progress");

  // Every question answered: the first "No", the rest "Yes".
  const questions = main(page).getByRole("group", { name: /^\d+\. / });
  const count = await questions.count();
  for (let i = 0; i < count; i++) {
    await questions
      .nth(i)
      .getByRole("radio", { name: i < 2 ? "No" : "Yes", exact: true })
      .check();
  }
  await main(page).getByRole("button", { name: "Save answers" }).click();
  await arrived(page, "Answers saved.");
  await expect(
    main(page).getByRole("heading", { name: "What fell short, by quality statement" }),
  ).toBeVisible();
  await bothThemes(page, "answers saved");

  // Completion: refused without the actions and the rating, each problem its own summary link
  // naming its question and focusing its own field; then completed.
  await expect(page).toHaveTitle(/^Audit\b/);
  await main(page).getByRole("button", { name: "Complete audit" }).click();
  await expect(main(page).getByText("Choose your self-rating").first()).toBeVisible();
  const ownerLinks = main(page).getByRole("link", { name: /^Choose who owns the action for: / });
  await expect(ownerLinks).toHaveCount(2);
  await ownerLinks.nth(1).click();
  await expect(main(page).getByLabel("Owner", { exact: true }).nth(1)).toBeFocused();
  await bothThemes(page, "completion refused");
  for (let i = 0; i < 2; i++) {
    await main(page)
      .getByLabel("What will be done", { exact: true })
      .nth(i)
      .fill("Retrain the team on MAR charts");
    await main(page).getByLabel("Owner", { exact: true }).nth(i).selectOption({ index: 1 });
  }
  await main(page).getByRole("radio", { name: "Good (3)" }).check();
  await main(page).getByRole("button", { name: "Complete audit" }).click();
  await arrived(page, "Audit completed.");
  await expect(main(page).getByText("Self-rating: Good (3)")).toBeVisible();
  await expect(main(page).getByText("Retrain the team on MAR charts")).toHaveCount(2);
  await expect(main(page).getByText(/weighted points/)).toBeVisible();
  await bothThemes(page, "audit completed");

  // Tagged as evidence from the audit itself.
  await main(page).getByRole("link", { name: "Tag as evidence" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Tag as evidence" })).toBeVisible();
  await bothThemes(page, "tag an audit");
  // Nothing chosen: the summary link takes focus to the first statement, announced as invalid.
  await main(page).getByRole("button", { name: "Tag as evidence" }).click();
  await main(page).getByRole("link", { name: "Choose at least one quality statement" }).click();
  const first = main(page)
    .getByRole("group", { name: "Quality statements" })
    .getByRole("checkbox")
    .first();
  await expect(first).toBeFocused();
  await expect(first).toHaveAttribute("aria-invalid", "true");
  await bothThemes(page, "tag refused");
  await main(page).getByRole("checkbox", { name: "Medicines optimisation" }).check();
  await main(page).getByRole("button", { name: "Tag as evidence" }).click();
  await arrived(page, "Tagged as evidence.");
  await expect(main(page).getByText("Tagged", { exact: true })).toBeVisible();
  await bothThemes(page, "audit tagged");
});

test("the manager starts a mock inspection against the framework in force", async ({ page }) => {
  test.setTimeout(180_000);
  await signIn(page, "manager@example.invalid");
  await page.goto("/quality/audits/templates");
  await main(page)
    .getByLabel("Starter template", { exact: true })
    .selectOption({ label: "Mock inspection" });
  await main(page).getByLabel("Short name", { exact: true }).fill(`mock-${RUN}`);
  await main(page).getByRole("button", { name: "Add template" }).click();
  await arrived(page, "Template added.");
  await page.goto("/quality/audits/new");
  await main(page)
    .getByLabel("Template", { exact: true })
    .selectOption({ label: "Mock inspection (mock inspection)" });
  await main(page).getByLabel("Location", { exact: true }).selectOption({ label: "Harbour House" });
  await main(page).getByRole("button", { name: "Start audit" }).click();
  await arrived(page, "Audit started.");
  await expect(page.getByText("Mock inspection").first()).toBeVisible();
  await bothThemes(page, "mock inspection in progress");
  await page.getByRole("link", { name: "Back to audits" }).click();
  await expect(main(page).getByRole("heading", { name: "Mock inspections" })).toBeVisible();
  await bothThemes(page, "audits overview");
});
