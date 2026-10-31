import { expect, type Page, test } from "@playwright/test";
import { demoPerson, expectAccessible, signIn } from "./support";

/**
 * Personal details (PEOP-001; people.md rule 15): the demographics, the national data opt-out in
 * words and an icon, and contacts and legal representatives with their evidence and end date. The
 * Registered Manager records the opt-out (and takes it off again), corrects a detail after an NHS
 * number the form refuses, and adds an attorney flagged "Evidence not recorded" until the
 * reference is added. The nurse reads it all and is offered no form. Everything this journey
 * writes is named with the run, so re-runs and other journeys on the same database are unaffected
 * (no names, dates of birth or NHS numbers change). Axe checks light and dark themes.
 */

const RUN = Date.now().toString(36);
const FRANK = demoPerson(6);
const PATH = `/people/${FRANK}/details`;
const PEOPLE = "Residents";

const main = (page: Page) => page.getByRole("main");
const optOut = (page: Page) => main(page).getByRole("region", { name: "National data opt-out" });
const details = (page: Page) => main(page).getByRole("region", { name: "Who they are" });
const contacts = (page: Page) =>
  main(page).getByRole("region", { name: "Contacts and representatives" });

/** A day this many days from today, as the date boxes take it. */
function dayParts(days: number) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/London",
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    })
      .formatToParts(new Date(Date.now() + days * 86_400_000))
      .map((p) => [p.type, p.value]),
  );
  return { day: parts.day ?? "", month: parts.month ?? "", year: parts.year ?? "" };
}

async function fillDay(page: Page, legend: string, days: number) {
  const group = main(page).getByRole("group", { name: legend });
  const { day, month, year } = dayParts(days);
  await group.getByLabel("Day", { exact: true }).fill(day);
  await group.getByLabel("Month", { exact: true }).fill(month);
  await group.getByLabel("Year", { exact: true }).fill(year);
}

// Each journey checks several states in both themes: more than the default minute.
test.describe.configure({ mode: "serial", timeout: 180_000 });

test("the national data opt-out shows in words and an icon, and the manager records and removes it", async ({
  page,
}) => {
  await signIn(page, "manager@example.invalid");
  await page.goto(PATH);
  await expect(page.getByRole("heading", { level: 2, name: "Personal details" })).toBeVisible();
  // The title names the tab, never the person.
  await expect(page).toHaveTitle(`Personal details | ${PEOPLE} | Harbour`);
  expect(await page.title()).not.toContain("Frank");
  await expect(details(page).getByText("999 000 0069")).toBeVisible();
  await expect(details(page).getByText("25/01/1946")).toBeVisible();
  await expectAccessible(page, "personal details");
  await page.emulateMedia({ colorScheme: "dark" });
  await expectAccessible(page, "personal details, dark theme");
  await page.emulateMedia({ colorScheme: "light" });

  // Whatever an earlier run left, the flag reads in words with an icon beside them.
  const region = optOut(page);
  const start = await region.locator("[data-opt-out]").getAttribute("data-opt-out");
  const record = region.getByRole("button", { name: "Record that they have opted out" });
  const remove = region.getByRole("button", { name: "Record that they have not opted out" });
  if (start === "opted_out") {
    await remove.click();
    await expect(main(page).getByText("Opt-out removed")).toBeVisible();
  }
  await expect(region.getByText("Not opted out", { exact: true })).toBeVisible();
  await expect(region.locator("p", { hasText: "Not opted out" }).locator("svg")).toBeVisible();

  await record.click();
  const recorded = main(page).getByText("Opt-out recorded");
  await expect(recorded).toBeVisible();
  await expect(main(page).locator("[data-arrival-notice]")).toBeFocused();
  await expect(region.locator("[data-opt-out]")).toHaveAttribute("data-opt-out", "opted_out");
  await expect(region.getByText("Opted out", { exact: true })).toBeVisible();
  await expect(region.locator("p", { hasText: /^Opted out$/ }).locator("svg")).toBeVisible();
  await expect(region.getByText(/not used for research or planning/)).toBeVisible();
  await expectAccessible(page, "opted out");

  // Taken off again, so the demo person is as other journeys expect.
  await remove.click();
  await expect(main(page).getByText("Opt-out removed")).toBeVisible();
  await expect(region.locator("[data-opt-out]")).toHaveAttribute("data-opt-out", "not_opted_out");
});

test("a detail is corrected after the form refuses an NHS number whose check digit does not match", async ({
  page,
}) => {
  await signIn(page, "manager@example.invalid");
  await page.goto(PATH);
  await details(page).getByRole("button", { name: "Change personal details" }).click();
  const form = details(page).locator("form");
  const nhs = form.getByLabel("NHS number");
  await expect(nhs).toHaveValue("9990000069");
  await nhs.fill("999 000 0019");
  await form.getByLabel("Religion or belief").fill(`Quaker ${RUN}`);
  await form.getByRole("button", { name: "Save personal details" }).click();

  // The summary takes focus and links to the field, which says the same beside it.
  const alert = details(page).getByRole("alert");
  await expect(alert).toBeFocused();
  const problem = "Check the NHS number: its last digit does not match the others";
  await alert.getByRole("link", { name: problem }).click();
  await expect(nhs).toBeFocused();
  await expect(nhs).toHaveAttribute("aria-invalid", "true");
  await expectAccessible(page, "personal details form with an error");
  await page.emulateMedia({ colorScheme: "dark" });
  await expectAccessible(page, "personal details form with an error, dark theme");
  await page.emulateMedia({ colorScheme: "light" });

  // Put back as it was: only the religion changes.
  await nhs.fill("999 000 0069");
  await form.getByRole("button", { name: "Save personal details" }).click();
  await expect(main(page).getByText("Personal details saved")).toBeVisible();
  await expect(details(page).locator("form")).toHaveCount(0);
  await expect(details(page).getByText(`Quaker ${RUN}`)).toBeVisible();
  await expect(details(page).getByText("999 000 0069")).toBeVisible();

  // The earlier version is kept in the record's history.
  await page.goto(`/people/${FRANK}/history`);
  await expect(page.getByRole("heading", { level: 2, name: "History" })).toBeVisible();
});

test("an attorney without a reference is flagged until it is recorded, and a deputy needs an order scope", async ({
  page,
}) => {
  await signIn(page, "manager@example.invalid");
  await page.goto(PATH);
  const region = contacts(page);
  await region.getByRole("button", { name: "Add a contact or representative" }).click();
  const form = region.locator("form").last();
  await form.getByLabel("Who they are").selectOption("deputy");
  await form.getByLabel("Given name").fill("Dee");
  await form.getByLabel("Family name").fill(`Deputy ${RUN}`);
  await form.getByRole("button", { name: "Add contact" }).click();
  const alert = region.getByRole("alert");
  await expect(alert).toBeFocused();
  await expect(
    alert.getByRole("link", { name: "Choose what the deputy's order covers" }),
  ).toBeVisible();
  await expectAccessible(page, "contact form with an error");

  // An attorney for health and welfare, valid for a year, with no reference or evidence yet.
  await form.getByLabel("Who they are").selectOption("lpa_health_welfare");
  await form.getByLabel("Family name").fill(`Attorney ${RUN}`);
  await form.getByLabel("Given name").fill("Pat");
  await form.getByLabel("Relationship to the person").fill("Niece");
  await form.getByLabel("Email address").fill(`pat.${RUN}@example.invalid`);
  await fillDay(page, "Valid until", 365);
  await form.getByRole("button", { name: "Add contact" }).click();
  await expect(main(page).getByText("Contact added")).toBeVisible();

  const name = `Pat Attorney ${RUN}`;
  const card = region.getByRole("listitem").filter({
    has: page.getByRole("heading", { level: 5, name }),
  });
  await expect(card.getByText("Attorney for health and welfare (LPA)")).toBeVisible();
  await expect(card.getByText("Evidence not recorded")).toBeVisible();
  await expect(card.getByText(/^Valid until \d{2}\/\d{2}\/\d{4}$/)).toBeVisible();
  await expect(card.getByText(/Nothing is shared on this authority/)).toBeVisible();
  await expectAccessible(page, "contacts with a flagged attorney");
  await page.emulateMedia({ colorScheme: "dark" });
  await expectAccessible(page, "contacts with a flagged attorney, dark theme");
  await page.emulateMedia({ colorScheme: "light" });

  await card.getByRole("button", { name: `Change ${name}'s details` }).click();
  await card.getByLabel("Reference").fill(`OPG-${RUN}`);
  await card.getByRole("button", { name: "Save contact" }).click();
  await expect(main(page).getByText("Contact saved")).toBeVisible();
  const saved = contacts(page)
    .getByRole("listitem")
    .filter({
      has: page.getByRole("heading", { level: 5, name }),
    });
  await expect(saved.getByText(`OPG-${RUN}`)).toBeVisible();
  await expect(saved.getByText("Evidence not recorded")).toHaveCount(0);
});

test("the nurse reads personal details and contacts but is offered no form and no sharing tab", async ({
  page,
}) => {
  await signIn(page, "nurse@example.invalid");
  await page.goto(PATH);
  await expect(page.getByRole("heading", { level: 2, name: "Personal details" })).toBeVisible();
  await expect(optOut(page).getByText(/^(Not opted out|Opted out)$/)).toBeVisible();
  await expect(details(page).getByText("999 000 0069")).toBeVisible();
  await expect(
    contacts(page).getByRole("heading", { level: 4, name: "Key contacts" }),
  ).toBeVisible();
  for (const region of [optOut(page), details(page), contacts(page)]) {
    await expect(region.getByRole("button")).toHaveCount(0);
  }
  const tabs = page.getByRole("navigation", { name: "Sections of Frank's record" });
  await expect(tabs.getByRole("link", { name: "Personal details", exact: true })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(tabs.getByRole("link", { name: "Sharing", exact: true })).toHaveCount(0);
  await expectAccessible(page, "personal details, read only");
});
