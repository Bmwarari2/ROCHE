import { randomUUID } from "node:crypto";
import { type APIRequestContext, type Browser, expect, type Page, test } from "@playwright/test";
import { demoPerson, expectAccessible, signIn } from "./support";

/**
 * Homely remedies on the web (slice 55; MEDS-007; medicines.md section 15.3; HZ-120, HZ-007)
 * against the demo tenant. The manager adds a protocol at Harbour House naming the nurse, then
 * changes it with a reason. The nurse checks a dose for a resident with the API before giving it
 * (a dose that is not the protocol's is said in the API's words), records one with the person and
 * every allergy beside the form, sees the next one is too soon, and marks the dose entered in
 * error. The manager then withdraws the protocol. Each screen is checked with axe in light and
 * dark, with and without errors.
 */

const API_URL = process.env.API_URL ?? "http://localhost:4000";
const DEMO_TENANT = "0194d000-0000-7000-8000-000000000001";
const DEMO_LOCATION = "0194d000-0000-7000-8000-000000000101";
const RUN = randomUUID().slice(0, 8);
const PRODUCT = `Paracetamol 500mg tablets ${RUN}`;

test.describe.configure({ mode: "serial" });

const main = (page: Page) => page.getByRole("main");
/** The notice a form leaves on the page it went to; the forms' own live regions are there too. */
const arrival = (page: Page, words: string) =>
  expect(main(page).getByRole("status").filter({ hasText: words })).toBeVisible();
const headers = { "x-harbour-tenant": DEMO_TENANT };

async function bothThemes(page: Page, name: string) {
  await expectAccessible(page, `${name} (light)`);
  await page.emulateMedia({ colorScheme: "dark" });
  await expectAccessible(page, `${name} (dark)`);
  await page.emulateMedia({ colorScheme: "light" });
}

async function signedIn(browser: Browser, email: string): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await signIn(page, email);
  return page;
}

/** A resident of Harbour House the nurse can read. */
async function resident(request: APIRequestContext): Promise<string> {
  for (let n = 1; n <= 6; n++) {
    const id = demoPerson(n);
    const r = await request.get(`${API_URL}/v1/people/${id}`, { headers });
    if (!r.ok()) continue;
    const body = (await r.json()) as { locationId: string };
    if (body.locationId === DEMO_LOCATION) return id;
  }
  throw new Error("No demo resident lives at Harbour House: reseed the database");
}

/** A UK calendar date `days` from today, as its day, month and year boxes. */
function ukDate(days: number): { day: string; month: string; year: string } {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    day: "numeric",
    month: "numeric",
    year: "numeric",
  }).formatToParts(new Date(Date.now() + days * 86_400_000));
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return { day: part("day"), month: part("month"), year: part("year") };
}

async function fillDate(page: Page, legend: string, days: number) {
  const group = main(page).getByRole("group", { name: legend });
  const date = ukDate(days);
  await group.getByLabel("Day").fill(date.day);
  await group.getByLabel("Month").fill(date.month);
  await group.getByLabel("Year").fill(date.year);
}

test("hazard HZ-120 hazard HZ-007 homely remedies only within the home's protocol", async ({
  browser,
}) => {
  test.setTimeout(300_000);
  const nurse = await signedIn(browser, "nurse@example.invalid");
  const me = await nurse.request.get(`${API_URL}/v1/me`, { headers });
  expect(me.ok()).toBe(true);
  const nurseName = ((await me.json()) as { user: { name: string } }).user.name;
  const person = await resident(nurse.request);

  // The manager's list of protocols at the home.
  const manager = await signedIn(browser, "manager@example.invalid");
  await manager.goto(`/medicines-stock/${DEMO_LOCATION}/homely-remedies`);
  await expect(
    main(manager).getByRole("heading", { name: "Homely remedies", level: 1 }),
  ).toBeVisible();
  await bothThemes(manager, "the home's homely remedy protocols");

  // Add a protocol: every mistake is said at its field first.
  await main(manager).getByRole("link", { name: "Add a protocol" }).click();
  await manager.waitForURL(/\/homely-remedies\/new$/);
  await main(manager).getByRole("button", { name: "Add the protocol" }).click();
  await expect(main(manager).getByRole("alert")).toBeFocused();
  await expect(
    main(manager).getByText("Choose at least one member of staff.").first(),
  ).toBeVisible();
  await bothThemes(manager, "add a protocol with errors");
  await main(manager).getByLabel("Product", { exact: true }).fill(PRODUCT);
  await main(manager).getByLabel("What it is for").fill("Mild pain or a raised temperature");
  await main(manager).getByLabel("One dose").fill("2");
  await main(manager).getByLabel("Unit", { exact: true }).fill("tablet");
  await main(manager).getByLabel("Shortest gap between doses, in hours").fill("4");
  await main(manager).getByLabel("Most in 24 hours").fill("8");
  await main(manager).getByLabel("Days before the GP is asked").fill("2");
  await main(manager)
    .getByRole("group", { name: "Staff allowed to give it" })
    .getByRole("checkbox", { name: new RegExp(nurseName) })
    .check();
  await main(manager).getByLabel("Name of the GP or pharmacist who agreed it").fill("Dr A Example");
  await main(manager).getByRole("radio", { name: "GP", exact: true }).check();
  await fillDate(manager, "Date it was agreed", -1);
  await fillDate(manager, "Review by", 30);
  await bothThemes(manager, "add a protocol");
  await main(manager).getByRole("button", { name: "Add the protocol" }).click();
  await manager.waitForURL(/\/homely-remedies\?done=added/);
  await arrival(manager, "Protocol added");
  const card = main(manager).getByRole("article").filter({ hasText: PRODUCT });
  await expect(card).toContainText("In use");
  await bothThemes(manager, "the protocols after one is added");

  // Change it: a new reason is needed.
  await card.getByRole("link", { name: `Change the protocol for ${PRODUCT}` }).click();
  await manager.waitForURL(/\/change$/);
  await expect(main(manager).getByLabel("One dose")).toHaveValue("2");
  await main(manager).getByLabel("Days before the GP is asked").fill("3");
  await main(manager).getByRole("button", { name: "Change the protocol" }).click();
  await expect(
    main(manager)
      .getByText("Enter why the protocol is changing, in 500 characters or fewer.")
      .first(),
  ).toBeVisible();
  await bothThemes(manager, "change a protocol with errors");
  await main(manager).getByLabel("Why it is changing").fill("Agreed again with the GP");
  await main(manager).getByRole("button", { name: "Change the protocol" }).click();
  await manager.waitForURL(/\/homely-remedies\?done=changed/);
  await arrival(manager, "Protocol changed");
  await expect(main(manager).getByRole("article").filter({ hasText: PRODUCT })).toContainText(
    "Last changed because Agreed again with the GP",
  );

  // The nurse gives it: the person and every allergy beside the form (HZ-007).
  await nurse.goto(`/people/${person}/medicines/homely-remedies`);
  const give = main(nurse).getByRole("region", { name: "Give a homely remedy" });
  await expect(give.getByRole("region", { name: "Who this medicine is for" })).toContainText(
    "Allergies:",
  );
  await bothThemes(nurse, "a person's homely remedies");
  await give
    .getByLabel("Protocol", { exact: true })
    .selectOption({ label: `${PRODUCT}, for Mild pain or a raised temperature` });
  await expect(give.getByRole("region", { name: "The protocol" })).toContainText("4 hours");
  await expect(give.getByLabel("Amount, in tablet")).toHaveValue("2");
  // Not the protocol's dose: the API says so in its words, and nothing can be recorded.
  await give.getByLabel("Amount, in tablet").fill("3");
  await give.getByRole("button", { name: "Check against the protocol" }).click();
  const found = give.getByRole("region", { name: "What the check found" });
  await expect(found).toContainText("Give the dose the protocol states.");
  await expect(give.getByRole("button", { name: "Record the dose" })).toHaveCount(0);
  await bothThemes(nurse, "a dose outside the protocol");
  // The protocol's dose is within it now.
  await give.getByLabel("Amount, in tablet").fill("2");
  await expect(found).toContainText("check again");
  await give.getByRole("button", { name: "Check against the protocol" }).click();
  await expect(found).toContainText("The check found this dose is within the protocol now.");
  await give.getByRole("button", { name: "Record the dose" }).click();
  await expect(main(nurse).getByRole("alert")).toBeFocused();
  await expect(
    give.getByText("Compare the person's allergies with this remedy, then tick the box.").first(),
  ).toBeVisible();
  await bothThemes(nurse, "record a homely remedy with errors");
  await give.getByLabel("Why it is given").fill("Headache");
  await give.getByLabel("I have compared the person's allergies with this remedy").check();
  await give.getByRole("button", { name: "Record the dose" }).click();
  await nurse.waitForURL(/\/homely-remedies\?done=recorded/);
  await arrival(nurse, "Homely remedy recorded");
  const doses = main(nurse).getByRole("region", { name: "Doses given" });
  await expect(doses).toContainText(PRODUCT);
  await expect(doses).toContainText("Given for Headache");
  await bothThemes(nurse, "the doses after one is recorded");

  // The next dose is too soon (HZ-120), in the API's words.
  const again = main(nurse).getByRole("region", { name: "Give a homely remedy" });
  await again
    .getByLabel("Protocol", { exact: true })
    .selectOption({ label: `${PRODUCT}, for Mild pain or a raised temperature` });
  await again.getByRole("button", { name: "Check against the protocol" }).click();
  await expect(again.getByRole("region", { name: "What the check found" })).toContainText(
    "It is too soon after the last dose under this protocol.",
  );

  // Entered in error: the dose stays, struck through, with the reason.
  const row = doses.getByRole("listitem").filter({ hasText: PRODUCT });
  await row
    .getByRole("button", { name: `Mark the dose of ${PRODUCT} as entered in error` })
    .click();
  await row.getByRole("button", { name: "Mark as entered in error" }).click();
  await expect(
    row.getByText("Enter why the dose was entered in error, in 500 characters or fewer.").first(),
  ).toBeVisible();
  await bothThemes(nurse, "mark a dose entered in error with errors");
  await row.getByLabel("Why it was entered in error").fill("Recorded for the wrong time");
  await row.getByRole("button", { name: "Mark as entered in error" }).click();
  await nurse.waitForURL(/\/homely-remedies\?done=marked/);
  await arrival(nurse, "Dose marked as entered in error");
  const marked = main(nurse)
    .getByRole("region", { name: "Doses given" })
    .getByRole("listitem")
    .filter({ hasText: PRODUCT });
  await expect(marked).toContainText("Entered in error");
  await expect(marked).toContainText("because Recorded for the wrong time");
  await bothThemes(nurse, "a dose entered in error");

  // The manager withdraws the protocol with a reason.
  await manager.goto(`/medicines-stock/${DEMO_LOCATION}/homely-remedies`);
  await main(manager)
    .getByRole("article")
    .filter({ hasText: PRODUCT })
    .getByRole("link", { name: `Withdraw the protocol for ${PRODUCT}` })
    .click();
  await manager.waitForURL(/\/withdraw$/);
  await main(manager).getByRole("button", { name: "Withdraw the protocol" }).click();
  await expect(main(manager).getByRole("alert")).toBeFocused();
  await bothThemes(manager, "withdraw a protocol with errors");
  await main(manager).getByLabel("Why it is being withdrawn").fill("No longer agreed");
  await main(manager).getByRole("button", { name: "Withdraw the protocol" }).click();
  await manager.waitForURL(/\/homely-remedies\?done=withdrawn/);
  const withdrawn = main(manager).getByRole("article").filter({ hasText: PRODUCT });
  await expect(withdrawn).toContainText("Withdrawn");
  await expect(withdrawn.getByRole("link")).toHaveCount(0);
  await bothThemes(manager, "the protocols after one is withdrawn");
});
