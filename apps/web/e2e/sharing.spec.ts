import { type APIRequestContext, expect, type Page, test } from "@playwright/test";
import { demoPerson, expectAccessible, signIn } from "./support";

/**
 * Sharing decisions (PEOP-013; people.md rule 13; hazard HZ-022). A family member added for this
 * run sees nothing until a decision is in force: the check says each section is closed and why.
 * The Registered Manager records a decision (the form first lists every problem at once), and the
 * check opens only the sections it covers; suspending closes them at once, lifting opens them
 * again, and withdrawing closes them for good. The nurse has no sharing tab. The run's contact and
 * decision are named with the run, so re-runs and the family feed journey (on another person) are
 * unaffected. Axe checks light and dark themes.
 */

const RUN = Date.now().toString(36);
const API_URL = process.env.API_URL ?? "http://localhost:4000";
const DEMO_TENANT = "0194d000-0000-7000-8000-000000000001";
const FRANK = demoPerson(6);
const PATH = `/people/${FRANK}/sharing`;
const RECIPIENT = `Kim Kin ${RUN}, Next of kin`;

const main = (page: Page) => page.getByRole("main");
const decisions = (page: Page) => main(page).getByRole("region", { name: "Sharing decisions" });
const check = (page: Page) =>
  main(page).getByRole("region", { name: "What one recipient can see now" });

async function post<T>(request: APIRequestContext, path: string, data: object): Promise<T> {
  const response = await request.post(`${API_URL}${path}`, {
    headers: { "x-harbour-tenant": DEMO_TENANT },
    data,
  });
  expect(response.ok(), `${path} ${await response.text()}`).toBe(true);
  return (await response.json()) as T;
}

async function themes(page: Page, name: string) {
  await expectAccessible(page, name);
  await page.emulateMedia({ colorScheme: "dark" });
  await expectAccessible(page, `${name}, dark theme`);
  await page.emulateMedia({ colorScheme: "light" });
}

/** Runs the check for the run's family member and returns its table. */
async function checkRecipient(page: Page, contactId: string) {
  await check(page).getByLabel("Recipient").selectOption(`contact:${contactId}`);
  await check(page).getByRole("button", { name: "Check" }).click();
  const table = check(page).getByRole("table", { name: `What ${RECIPIENT} can see now` });
  await expect(table).toBeVisible();
  return table;
}

const row = (page: Page, section: string) =>
  check(page).locator(`[data-visibility] tr[data-section="${section}"]`);

const card = (page: Page) =>
  decisions(page)
    .locator("li[data-decision]")
    .filter({ has: page.getByRole("heading", { level: 4, name: RECIPIENT }) });

async function arrive(page: Page, words: string) {
  const arrival = main(page).locator("[data-arrival-notice]");
  await expect(arrival).toHaveText(words);
  await expect(arrival).toBeFocused();
}

// Each journey checks several states in both themes: more than the default minute.
test.describe.configure({ mode: "serial", timeout: 180_000 });

test("hazard HZ-022 nothing is shared until a decision is in force, and suspending or withdrawing closes it at once", async ({
  page,
}) => {
  await signIn(page, "manager@example.invalid");
  const contact = await post<{ id: string }>(page.request, `/v1/people/${FRANK}/contacts`, {
    role: "next_of_kin",
    givenName: "Kim",
    familyName: `Kin ${RUN}`,
    relationship: "Grandchild",
    email: `kim.${RUN}@example.invalid`,
  });

  await page.goto(PATH);
  await expect(page.getByRole("heading", { level: 2, name: "Sharing" })).toBeVisible();
  await expect(page).toHaveTitle("Sharing | Residents | Harbour");
  expect(await page.title()).not.toContain("Frank");

  // Closed by default: every section, with the reason in words and an icon.
  const closed = await checkRecipient(page, contact.id);
  await expect(closed.locator("tbody tr")).toHaveCount(11);
  await expect(closed.getByText("Open", { exact: true })).toHaveCount(0);
  await expect(closed.getByText("No decision for this recipient")).toHaveCount(11);
  await expect(row(page, "photos").locator("svg")).toBeVisible();
  await themes(page, "sharing tab");

  // The form lists every problem at once, each linked to its question.
  await decisions(page).getByRole("button", { name: "Record a sharing decision" }).click();
  const form = decisions(page).locator("form");
  await form.getByRole("button", { name: "Record decision" }).click();
  const alert = decisions(page).getByRole("alert");
  await expect(alert).toBeFocused();
  for (const problem of [
    "Choose who will see it",
    "Choose at least one section",
    "Choose what the decision rests on",
    "The day the decision ends must include a day, month and year",
  ]) {
    await expect(alert.getByRole("link", { name: problem })).toBeVisible();
  }
  await themes(page, "sharing decision form with errors");

  await form.getByRole("radio", { name: "A family member or representative" }).check();
  await form
    .getByLabel("Family member or representative", { exact: true })
    .selectOption(contact.id);
  await form.getByRole("checkbox", { name: "Activities and visits" }).check();
  await form.getByRole("checkbox", { name: "Photos", exact: true }).check();
  await form.getByRole("radio", { name: "Consent", exact: true }).check();
  await form.getByRole("radio", { name: "Given by them" }).check();
  const ends = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/London",
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    })
      .formatToParts(new Date(Date.now() + 30 * 86_400_000))
      .map((p) => [p.type, p.value]),
  ) as Record<string, string>;
  const until = form.getByRole("group", { name: "In force until the end of" });
  await until.getByLabel("Day", { exact: true }).fill(ends.day ?? "");
  await until.getByLabel("Month", { exact: true }).fill(ends.month ?? "");
  await until.getByLabel("Year", { exact: true }).fill(ends.year ?? "");
  await form.getByRole("button", { name: "Record decision" }).click();
  await arrive(page, "Sharing decision recorded");
  await expect(decisions(page).locator("form")).toHaveCount(0);
  await expect(card(page).getByText("In force", { exact: true })).toBeVisible();
  await expect(card(page).getByText("Photos, Activities and visits")).toBeVisible();
  await themes(page, "sharing decision in force");

  // Only what the decision covers opens.
  await checkRecipient(page, contact.id);
  await expect(row(page, "activities_and_visits")).toContainText("Open");
  await expect(row(page, "activities_and_visits")).toContainText("A decision in force opens it");
  await expect(row(page, "medicines")).toContainText("Closed");
  await expect(row(page, "medicines")).toContainText("No decision covers this section");

  // Suspended (for example during a safeguarding enquiry): closed at once.
  await card(page)
    .getByRole("button", { name: `Suspend sharing with ${RECIPIENT}` })
    .click();
  await card(page).getByLabel("Why is sharing suspended?").fill(`Enquiry open, run ${RUN}`);
  await card(page).getByRole("button", { name: "Suspend sharing", exact: true }).click();
  await arrive(page, "Sharing suspended");
  await expect(card(page).getByText("Suspended", { exact: true }).first()).toBeVisible();
  await checkRecipient(page, contact.id);
  await expect(row(page, "activities_and_visits")).toContainText("Sharing is suspended");

  await card(page)
    .getByRole("button", { name: `Lift the suspension for ${RECIPIENT}` })
    .click();
  await card(page).getByLabel("Why can sharing start again?").fill(`Enquiry closed, run ${RUN}`);
  await card(page).getByRole("button", { name: "Lift the suspension", exact: true }).click();
  await arrive(page, "Suspension lifted");
  await expect(card(page).getByText("In force", { exact: true })).toBeVisible();
  // The suspension stays on the record, with its reason.
  await expect(card(page).getByText(new RegExp(`Enquiry open, run ${RUN}`))).toBeVisible();

  // Withdrawn: closed for good, with the reason.
  await card(page)
    .getByRole("button", { name: `Withdraw the decision for ${RECIPIENT}` })
    .click();
  await expect(card(page).getByText(/This cannot be undone/)).toBeVisible();
  await card(page).getByLabel("Why is the decision withdrawn?").fill(`End-to-end run ${RUN}`);
  await card(page).getByRole("button", { name: "Withdraw decision", exact: true }).click();
  await arrive(page, "Decision withdrawn");
  await expect(card(page).getByText("Withdrawn", { exact: true })).toBeVisible();
  await expect(card(page).getByRole("button")).toHaveCount(0);
  await checkRecipient(page, contact.id);
  await expect(row(page, "activities_and_visits")).toContainText("The decision was withdrawn");
  await expect(row(page, "photos")).toContainText("Closed");
  await themes(page, "sharing decision withdrawn");
});

test("the nurse has no sharing tab and the page says so in words", async ({ page }) => {
  await signIn(page, "nurse@example.invalid");
  await page.goto(`/people/${FRANK}`);
  const tabs = page.getByRole("navigation", { name: "Sections of Frank's record" });
  await expect(tabs.getByRole("link", { name: "About me", exact: true })).toBeVisible();
  await expect(tabs.getByRole("link", { name: "Sharing", exact: true })).toHaveCount(0);
  await page.goto(PATH);
  await expect(
    main(page).getByRole("heading", {
      level: 2,
      name: "You do not have access to this part of the record",
    }),
  ).toBeVisible();
  await expect(decisions(page)).toHaveCount(0);
  await expectAccessible(page, "sharing tab without access");
});
