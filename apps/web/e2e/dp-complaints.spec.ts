import { randomUUID } from "node:crypto";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { expectAccessible, signIn, signInWithDemoPasskey } from "./support";

/**
 * Data protection complaints (PLAT-022; platform.md rule 25) against the demo tenant. The owner
 * holds quality.dsar.manage across the organisation, so signs in with the end-to-end passkey;
 * the manager is refused. The owner records a complaint from an invented family member, sees the
 * acknowledgement clock in words, records the acknowledgement and an update, and closes it with
 * the outcome once confirming the outcome told them they can complain to the ICO. Each state is
 * checked with axe in light and dark. Each run tags its complaint, so the journey can run again.
 */

const RUN = randomUUID().slice(0, 8);
const NAME = `Ada Example ${RUN}`;
const PAGE = "/data-rights/complaints";

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

/** Today in the UK, as the date boxes take it and dd/mm/yyyy shows it. */
function ukToday() {
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
  return {
    day: parts.day ?? "",
    month: parts.month ?? "",
    year: parts.year ?? "",
    shown: `${parts.day}/${parts.month}/${parts.year}`,
  };
}

async function fillToday(group: Locator) {
  const today = ukToday();
  await group.getByLabel("Day", { exact: true }).fill(today.day);
  await group.getByLabel("Month", { exact: true }).fill(today.month);
  await group.getByLabel("Year", { exact: true }).fill(today.year);
}

/** The arrival: focus on the page's heading, and a status saying what was done. */
async function arrived(page: Page, words: string) {
  await expect(
    page.getByRole("heading", { level: 1, name: "Data protection complaint" }),
  ).toBeFocused();
  await expect(status(page, words)).toBeVisible();
}

test("the manager is not offered data protection complaints", async ({ page }) => {
  await signIn(page, "manager@example.invalid");
  await page.goto(PAGE);
  await expect(main(page)).toContainText("You do not have access to this");
  await bothThemes(page, "complaints refused");
});

test("the owner records, acknowledges, updates and closes a complaint", async ({ page }) => {
  test.setTimeout(150_000);
  await signInWithDemoPasskey(page, "owner");
  await page.goto(PAGE);
  await expect(
    page.getByRole("heading", { level: 1, name: "Data protection complaints" }),
  ).toBeVisible();
  await bothThemes(page, "complaints");

  // Every question is asked before anything is sent.
  const record = region(page, "Record a complaint");
  await record.getByRole("button", { name: "Record complaint" }).click();
  await expect(record.getByRole("alert")).toContainText("The day received");
  // Back to the top, so axe does not count a tab scrolled under the sticky app bar as obscured.
  await page.evaluate(() => window.scrollTo(0, 0));
  await bothThemes(page, "record a complaint refused");
  await fillToday(record.getByRole("group", { name: "Day received" }));
  await record.getByLabel("How it was made").selectOption({ label: "Email" });
  await record.getByLabel("Who complained").selectOption({ label: "A family member" });
  await record.getByLabel("Complainant's name").fill(NAME);
  await record.getByLabel("How to contact them (optional)").fill("ada@example.invalid");
  await record.getByLabel("What it is about").selectOption({ label: "Sharing of information" });
  await record
    .getByLabel("Summary")
    .fill(`Says her mother's care plan was shared with a cousin without asking ${RUN}`);
  await record.getByRole("button", { name: "Record complaint" }).click();
  await arrived(page, "Complaint recorded.");
  const standing = region(page, "Where it stands");
  await expect(standing).toContainText("Open");
  await expect(standing).toContainText(/Acknowledge by \d\d\/\d\d\/\d{4}/);
  await expect(standing).toContainText(/Next update due by \d\d\/\d\d\/\d{4}/);
  // Closing is not offered before the acknowledgement.
  await expect(region(page, "Outcome")).toHaveCount(0);
  await bothThemes(page, "complaint recorded");

  const today = ukToday();
  const acknowledge = region(page, "Acknowledgement");
  await fillToday(acknowledge.getByRole("group", { name: "When was it acknowledged?" }));
  await acknowledge.getByRole("button", { name: "Record acknowledgement" }).click();
  await arrived(page, "Acknowledgement recorded.");
  await expect(region(page, "Where it stands")).toContainText(`Acknowledged on ${today.shown}`);
  await expect(region(page, "Acknowledgement")).toHaveCount(0);
  await bothThemes(page, "complaint acknowledged");

  const update = region(page, "Update to the complainant");
  await fillToday(update.getByRole("group", { name: "When did you tell them how it is going?" }));
  await update.getByRole("button", { name: "Record update" }).click();
  await arrived(page, "Update recorded.");
  await expect(region(page, "Where it stands")).toContainText("Last update to the complainant");

  // Closing needs the outcome and confirmation that it stated the ICO right.
  const close = region(page, "Outcome");
  await fillToday(close.getByRole("group", { name: "Day closed" }));
  await close
    .getByLabel("Outcome", { exact: true })
    .fill("We found the plan was shared in error, apologised and changed who can see it.");
  await close.getByRole("button", { name: "Close complaint" }).click();
  await expect(close.getByRole("alert")).toContainText("complain to the ICO");
  await bothThemes(page, "closing refused");
  await close.getByLabel("The outcome told the complainant they can complain to the ICO").check();
  await close.getByRole("button", { name: "Close complaint" }).click();
  await arrived(page, "Complaint closed.");
  await expect(region(page, "Where it stands")).toContainText(`Closed on ${today.shown}`);
  await expect(region(page, "Outcome")).toContainText("Told they can complain to the ICO");
  await bothThemes(page, "complaint closed");

  await main(page).getByRole("link", { name: "Data protection complaints" }).first().click();
  const entry = region(page, "Complaints recorded").getByRole("listitem").filter({ hasText: NAME });
  await expect(entry).toContainText(`Acknowledged on ${today.shown}`);
  await expect(entry).toContainText(`Closed on ${today.shown}`);
  await bothThemes(page, "complaints with the closed one");
});
