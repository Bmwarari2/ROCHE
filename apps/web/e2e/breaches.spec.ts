import { randomUUID } from "node:crypto";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { expectAccessible, signIn, signInWithDemoPasskey } from "./support";

/**
 * The breach register (PLAT-022; platform.md rules 18 to 24) against the demo tenant. The owner
 * holds quality.dsar.manage across the organisation, so signs in with the end-to-end passkey;
 * the manager, who does not hold it for the whole organisation, is refused. The owner records a
 * breach, assesses it, reads Harbour's suggestion as decision support, decides against part of it
 * (acknowledging that), reports it to the ICO and closes it with lessons. Each state is checked
 * with axe in light and dark. Each run tags its entry, so the journey can run again on the same
 * database.
 */

const RUN = randomUUID().slice(0, 8);
const SUMMARY = `A letter about one person went to the wrong address ${RUN}`;
const PAGE = "/data-rights/breaches";
const DAY = 86_400_000;

test.describe.configure({ mode: "serial" });

const main = (page: Page) => page.getByRole("main");
const region = (page: Page, name: string) => main(page).getByRole("region", { name });
const status = (page: Page, words: string) =>
  main(page).getByRole("status").filter({ hasText: words });

async function bothThemes(page: Page, name: string) {
  await expectAccessible(page, `${name} (light)`);
  await page.emulateMedia({ colorScheme: "dark" });
  await expectAccessible(page, `${name} (dark)`);
  await page.emulateMedia({ colorScheme: "light" });
}

/** A UK calendar day `offset` days from today, as the date boxes take it. */
function ukDay(offset: number) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/London",
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    })
      .formatToParts(new Date(Date.now() + offset * DAY))
      .map((p) => [p.type, p.value]),
  );
  return { day: parts.day ?? "", month: parts.month ?? "", year: parts.year ?? "" };
}

async function fillDateTime(group: Locator, offset: number, hour: string, minute: string) {
  const day = ukDay(offset);
  await group.getByLabel("Day", { exact: true }).fill(day.day);
  await group.getByLabel("Month", { exact: true }).fill(day.month);
  await group.getByLabel("Year", { exact: true }).fill(day.year);
  await group.getByLabel("Hour", { exact: true }).fill(hour);
  await group.getByLabel("Minute", { exact: true }).fill(minute);
}

/** The arrival: focus on the page's heading, and a status saying what was done. */
async function arrived(page: Page, words: string) {
  await expect(page.getByRole("heading", { level: 1, name: "Breach" })).toBeFocused();
  await expect(status(page, words)).toBeVisible();
}

test("the manager is not offered the breach register", async ({ page }) => {
  await signIn(page, "manager@example.invalid");
  await page.goto(PAGE);
  await expect(main(page)).toContainText("You do not have access to this");
  await expect(main(page)).toContainText("whole organisation");
  await bothThemes(page, "breach register refused");
});

test("the owner records, assesses, decides, reports and closes a breach", async ({ page }) => {
  test.setTimeout(180_000);
  await signInWithDemoPasskey(page, "owner");
  await page.goto(PAGE);
  await expect(page.getByRole("heading", { level: 1, name: "Breach register" })).toBeVisible();
  await bothThemes(page, "breach register");

  // Recording needs what happened and when the organisation became aware, before sending.
  const record = region(page, "Record a breach");
  await record.getByRole("button", { name: "Record breach" }).click();
  await expect(record.getByRole("alert")).toContainText("Describe what happened");
  await record.getByRole("heading", { name: "Record a breach" }).scrollIntoViewIfNeeded();
  await page.evaluate(() => window.scrollBy(0, -80));
  await bothThemes(page, "record a breach refused");
  await record.getByLabel("What happened").fill(SUMMARY);
  await fillDateTime(
    record.getByRole("group", { name: "When did the organisation become aware of it?" }),
    -1,
    "09",
    "00",
  );
  await record.getByRole("button", { name: "Record breach" }).click();
  await arrived(page, "Breach recorded.");
  const standing = region(page, "Where it stands");
  await expect(standing).toContainText("To assess");
  await expect(standing).toContainText("ICO report due");
  await expect(standing).toContainText(/Report to the ICO by \d\d:\d\d on \d\d\/\d\d\/\d{4}: /);
  await expect(standing).toContainText(SUMMARY);
  await bothThemes(page, "breach recorded");

  // The assessment: identifiable health data sent outside the organisation, not recovered.
  const assess = region(page, "Assessment");
  await assess.getByLabel("How many people are affected?").fill("1");
  await assess.getByLabel("The people can be identified from what was affected").check();
  await assess.getByLabel("It includes health, care or other special category data").check();
  await assess.getByLabel("It was disclosed outside the organisation").check();
  await assess.getByRole("button", { name: "Save assessment" }).click();
  await arrived(page, "Assessment saved.");
  const suggestion = region(page, "Harbour's suggestion");
  await expect(suggestion).toContainText("Harbour suggests a high severity breach");
  await expect(suggestion).toContainText("the decision is yours");
  await expect(suggestion).toContainText("Identifiable data went outside the organisation");
  await expect(region(page, "Where it stands")).toContainText("To decide");
  await bothThemes(page, "breach assessed");

  // The decision: report, but not tell them, which goes against part of the suggestion.
  const decide = region(page, "Decision");
  await decide.getByRole("radio", { name: "Yes, report it to the ICO" }).check();
  await decide.getByRole("radio", { name: "No, do not tell them" }).check();
  await decide
    .getByLabel("Your reasons")
    .fill(`The letter was returned unopened the next day, so no one was harmed ${RUN}`);
  await decide.getByRole("button", { name: "Record decision" }).click();
  await expect(decide.getByRole("alert")).toContainText("tick the box");
  await bothThemes(page, "decision refused");
  await decide.getByLabel("I have read Harbour's suggestion and I am deciding differently").check();
  await decide.getByRole("button", { name: "Record decision" }).click();
  await arrived(page, "Decision recorded.");
  await expect(region(page, "Decision")).toContainText("going against Harbour's suggestion");
  await expect(region(page, "Where it stands")).toContainText("To report to the ICO");
  await bothThemes(page, "breach decided");

  // The report to the ICO, within the deadline the API gave.
  const report = region(page, "Report to the ICO");
  await fillDateTime(
    report.getByRole("group", { name: "When did you report it?" }),
    -1,
    "15",
    "30",
  );
  await report.getByLabel("ICO reference").fill(`IC-${RUN}`);
  await report.getByRole("button", { name: "Record report" }).click();
  await arrived(page, "Report to the ICO recorded.");
  await expect(region(page, "Where it stands")).toContainText("Reported on time");
  await expect(region(page, "Report to the ICO")).toContainText(`IC-${RUN}`);
  await expect(region(page, "Where it stands")).toContainText("Ready to close");
  await bothThemes(page, "breach reported");

  // Closing with the lessons.
  const close = region(page, "Closing");
  await close
    .getByLabel("Lessons learned")
    .fill("Addresses are now checked by a second person before letters are posted.");
  await close.getByRole("button", { name: "Close breach" }).click();
  await arrived(page, "Breach closed.");
  await expect(region(page, "Where it stands")).toContainText("Closed");
  await expect(region(page, "Decision").getByRole("button")).toHaveCount(0);
  await bothThemes(page, "breach closed");

  // The register says it newest first, with its clock in words.
  await main(page).getByRole("link", { name: "Breach register" }).first().click();
  const entry = region(page, "Breaches recorded")
    .getByRole("listitem")
    .filter({ hasText: SUMMARY });
  await expect(entry).toContainText("Closed");
  await expect(entry).toContainText("Reported on time");
  await bothThemes(page, "breach register with the closed entry");
});
