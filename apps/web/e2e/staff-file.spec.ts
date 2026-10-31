import { randomUUID } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import { expectAccessible, signIn } from "./support";

/**
 * Staff files, compliance, sponsored workers and My privacy (slice 56; WORK-002, WORK-003,
 * WORK-011) against the demo tenant. The owner holds every permission, so here they act as HR:
 * they set the staff privacy notice (an organisation document, H-940), keep Cat Carer's staff file and record a check, and
 * keep Cat's sponsor record (absence, a change to report, marked reported). Cat acknowledges the
 * notice and decides on an image use, and is offered neither staff files nor sponsor records. The
 * Registered Manager sees staff files but no sponsor records. Each state is checked with axe in
 * light and dark. Reruns find the records an earlier run made and carry on from them.
 */

const RUN = randomUUID().slice(0, 8);
const NOTICE = `Staff privacy notice ${RUN}`;
/** How the notice is named once chosen (H-940): its title and version. */
const VERSION = `${NOTICE}, version 1`;
const pdf = {
  name: "staff-privacy-notice.pdf",
  mimeType: "application/pdf",
  buffer: Buffer.from(`%PDF-1.7\n% ${RUN}\n1 0 obj\n<<>>\nendobj\n%%EOF\n`),
};
const CARER = "Cat Carer";

test.describe.configure({ mode: "serial" });

const main = (page: Page) => page.getByRole("main");
const nav = (page: Page) => page.getByRole("navigation", { name: "Modules" });

async function bothThemes(page: Page, name: string) {
  await expectAccessible(page, `${name} (light)`);
  await page.emulateMedia({ colorScheme: "dark" });
  await expectAccessible(page, `${name} (dark)`);
  await page.emulateMedia({ colorScheme: "light" });
}

/** Fills a day, month and year date field by its legend. */
async function fillDate(page: Page, legend: string, iso: string) {
  const [year, month, day] = iso.split("-");
  const group = main(page).getByRole("group", { name: legend, exact: true });
  await group.getByLabel("Day").fill(day ?? "");
  await group.getByLabel("Month").fill(month ?? "");
  await group.getByLabel("Year").fill(year ?? "");
}

const daysAgo = (days: number) => {
  const d = new Date(Date.now() - days * 86_400_000);
  return d.toISOString().slice(0, 10);
};

test("the owner sets the staff privacy notice from an organisation document", async ({ page }) => {
  await signIn(page, "owner@example.invalid");
  await page.goto("/documents");
  const upload = main(page).getByRole("region", { name: "Add a document" });
  await upload.getByLabel("Title").fill(NOTICE);
  await upload.getByLabel("File").setInputFiles(pdf);
  await upload.getByRole("button", { name: "Upload document" }).click();
  await expect(page.getByRole("heading", { level: 1, name: NOTICE })).toBeFocused();

  await page.goto("/settings/data-protection");
  const card = main(page).getByRole("region", { name: "Staff privacy notice" });
  await card.getByLabel("Notice in force").selectOption({ label: VERSION });
  await card.getByRole("button", { name: "Save the notice" }).click();
  await expect(
    main(page).getByRole("status").filter({ hasText: "Staff privacy notice saved." }),
  ).toBeVisible();
  await expect(card.getByLabel("Notice in force")).toHaveValue(/^[0-9a-f-]{36}$/);
  await bothThemes(page, "notice set");
});

test("a care worker acknowledges the notice and decides on an image use", async ({ page }) => {
  await signIn(page, "carer@example.invalid");
  await expect(nav(page).getByRole("link", { name: "Staff files" })).toHaveCount(0);
  await page.getByRole("button", { name: /Your account/ }).click();
  await page.getByRole("menuitem", { name: "My privacy" }).click();
  await page.waitForURL((url) => url.pathname === "/settings/privacy");
  await expect(main(page).getByRole("heading", { level: 1, name: "My privacy" })).toBeVisible();
  await bothThemes(page, "my privacy");

  // The notice is linked, by its title and version (H-940).
  await expect(main(page).getByRole("link", { name: `Open ${VERSION} (PDF)` })).toHaveAttribute(
    "href",
    /^\/documents\/[0-9a-f-]{36}$/,
  );
  await main(page)
    .getByRole("button", { name: `I have read ${VERSION}` })
    .click();
  await expect(
    main(page).getByRole("status").filter({ hasText: "Thank you. Your confirmation is saved." }),
  ).toBeVisible();
  // Focus starts at the top of what changed.
  await expect(main(page).getByRole("heading", { level: 1 })).toBeFocused();
  await expect(main(page).getByText(`You have confirmed you read ${VERSION}.`)).toBeVisible();

  const website = main(page).getByRole("region", { name: "Photos on the website" });
  const yes = website.getByRole("radio", { name: "Yes", exact: true });
  if ((await yes.count()) > 0) {
    await yes.check();
    await website.getByRole("button", { name: "Save my answer" }).click();
  } else if ((await website.getByRole("button", { name: "Give consent" }).count()) > 0) {
    await website.getByRole("button", { name: "Give consent" }).click();
  }
  await expect(website.getByText("Consent given", { exact: true })).toBeVisible();
  // Withdrawing is one button that says what it does.
  await expect(website).toContainText("your photo will not be used for this from now on");
  await website.getByRole("button", { name: "Withdraw consent" }).click();
  await expect(website.getByText("Consent withdrawn", { exact: true })).toBeVisible();
  await expect(
    main(page).getByRole("status").filter({ hasText: "Your answer about the website is saved." }),
  ).toBeVisible();
  await bothThemes(page, "image consent withdrawn");
});

test("a care worker is offered no staff files or sponsor records", async ({ page }) => {
  await signIn(page, "carer@example.invalid");
  for (const path of ["/staff", "/staff/sponsorship"]) {
    await page.goto(path);
    await expect(main(page)).toContainText("You do not have access to this");
  }
  await bothThemes(page, "sponsor records refused to a care worker");
});

test("the Registered Manager sees staff files but no sponsor records", async ({ page }) => {
  await signIn(page, "manager@example.invalid");
  await nav(page).getByRole("link", { name: "Staff files" }).click();
  await page.waitForURL((url) => url.pathname === "/staff");
  await expect(main(page).getByRole("link", { name: "Sponsored workers" })).toHaveCount(0);
  await bothThemes(page, "staff files for the manager");
  await page.goto("/staff/sponsorship");
  await expect(main(page)).toContainText("You do not have access to this");
});

test("HR keeps a staff file and records a check", async ({ page }) => {
  await signIn(page, "owner@example.invalid");
  await page.goto("/staff");
  const existing = main(page).getByRole("link", { name: CARER, exact: true });
  if ((await existing.count()) === 0) {
    const create = main(page).getByRole("region", { name: "Start a staff file" });
    await create.getByRole("button", { name: "Start the staff file" }).click();
    // Every problem at once, linked to its field.
    await expect(create.getByRole("alert")).toContainText("Choose the member of staff");
    await create.getByLabel("Member of staff").selectOption({ label: `${CARER}` });
    await create.getByLabel("Job title").fill("Care worker");
    await create.getByRole("button", { name: "Start the staff file" }).click();
    await page.waitForURL((url) => /^\/staff\/[0-9a-f-]{36}$/.test(url.pathname));
  } else {
    await existing.click();
  }
  await expect(main(page).getByRole("heading", { level: 1, name: CARER })).toBeVisible();
  await bothThemes(page, "staff file");

  const references = main(page)
    .getByRole("listitem")
    .filter({
      has: page.getByRole("heading", { name: "References", exact: true }),
    });
  // By keyboard: open the form from its control, fill it in and send it.
  const control = references.getByRole("button", { name: "Record references" });
  await control.focus();
  await page.keyboard.press("Enter");
  await expect(control).toHaveAttribute("aria-expanded", "true");
  await references.getByLabel("References received").fill("2");
  await references.getByLabel("I have verified this today").check();
  await references.getByRole("button", { name: "Save references" }).press("Enter");
  await expect(
    main(page).getByRole("status").filter({ hasText: "References saved" }),
  ).toBeVisible();
  await expect(main(page).getByRole("heading", { level: 1 })).toBeFocused();
  await expect(references.getByText("Done", { exact: true })).toBeVisible();
  await bothThemes(page, "a check recorded");
});

test("HR keeps a sponsor record: absence, a change to report and marking it reported", async ({
  page,
}) => {
  await signIn(page, "owner@example.invalid");
  await page.goto("/staff/sponsorship");
  await bothThemes(page, "sponsored workers");
  // Each run ends Cat's sponsorship when done, so an active record is one an interrupted run left.
  const existing = main(page)
    .getByRole("listitem")
    .filter({ hasNotText: "sponsorship ended" })
    .getByRole("link", { name: CARER, exact: true });
  if ((await existing.count()) === 0) {
    const create = main(page).getByRole("region", { name: "Record a sponsored worker" });
    await create.getByLabel("Member of staff").selectOption({ label: CARER });
    await create.getByLabel("Certificate of sponsorship number").fill(`C2X${RUN}`.toUpperCase());
    await fillDate(page, "Date the certificate was assigned", daysAgo(200));
    await create.getByLabel("Occupation code (SOC 2020)").fill("6145");
    await create.getByLabel("Route").selectOption({ label: "Health and Care Worker" });
    await fillDate(page, "Visa end date", daysAgo(-900));
    await create.getByLabel("Contracted hours a week").fill("37.5");
    await create.getByLabel("Guaranteed basic pay a year, in pounds").fill("30000");
    await create.getByLabel("Certificate of sponsorship", { exact: true }).check();
    await create.getByRole("button", { name: "Record the sponsored worker" }).click();
    await page.waitForURL((url) => /^\/staff\/sponsorship\/[0-9a-f-]{36}$/.test(url.pathname));
  } else {
    await existing.click();
  }
  await expect(main(page).getByRole("heading", { level: 1, name: CARER })).toBeVisible();

  const absence = main(page).getByRole("region", { name: "Record an absence" });
  await fillDate(page, "First day away", daysAgo(60));
  await fillDate(page, "Last day away", daysAgo(30));
  await absence.getByRole("radio", { name: "No, not authorised" }).check();
  await absence.getByRole("button", { name: "Record the absence" }).click();
  await expect(
    main(page).getByRole("status").filter({ hasText: "Absence recorded." }),
  ).toBeVisible();
  const warning = main(page).getByRole("region", { name: "Unauthorised absence to report" });
  await expect(warning).toBeVisible();
  await bothThemes(page, "absence to report");

  // The change form is filled in from the warning.
  const report = main(page).getByRole("region", { name: "Record a change to report" });
  await report.getByRole("button", { name: "Record the change" }).click();
  await expect(
    main(page).getByRole("status").filter({ hasText: "Change recorded." }),
  ).toBeVisible();
  await expect(warning).toHaveCount(0);

  const changes = main(page).getByRole("region", { name: "Reportable changes" });
  const open = changes.getByRole("listitem").filter({ hasText: "Overdue" }).first();
  await open.getByRole("button", { name: "Mark unauthorised absence as reported" }).first().click();
  await fillDate(page, "Date reported", daysAgo(0));
  await open.getByLabel("Sponsor management system reference").fill(`SMS-${RUN}`);
  await open.getByRole("button", { name: "Mark unauthorised absence as reported" }).last().click();
  await expect(
    main(page).getByRole("status").filter({ hasText: "Change marked as reported." }),
  ).toBeVisible();
  await expect(changes.getByText(`reference SMS-${RUN}`)).toBeVisible();
  await expect(changes.getByText("Reported late").first()).toBeVisible();
  await bothThemes(page, "change marked reported");

  // Sponsorship ends: the record is changed with an end date.
  const change = main(page).getByRole("region", { name: "Change the record" });
  await fillDate(page, "Sponsorship ended on (optional)", daysAgo(0));
  await change.getByRole("button", { name: "Save the record" }).click();
  await expect(main(page).getByRole("status").filter({ hasText: "Record saved." })).toBeVisible();
});
