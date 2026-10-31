import {
  type APIRequestContext,
  type BrowserContext,
  expect,
  type Locator,
  type Page,
  test,
} from "@playwright/test";
import { expectAccessible, signIn } from "./support";

/**
 * Pre-admission assessment and the decision to admit (PEOP-005; people.md rules 1, 4 and 5;
 * hazards HZ-007, HZ-015 and HZ-016) against the demo tenant. The Registered Manager records an
 * enquiry on the screen, starts the assessment, records the safety sections (never "not
 * applicable"), the medicines list and the sources, decides with reasons and a condition and
 * confirms it; a second enquiry is declined, its earlier decision struck through, and closed as not
 * admitted; the nurse writes sections but never decides; a care worker is not offered the list.
 * Every person here is made by this run, named with it (invented names, no NHS number), so runs
 * repeat and no demo resident changes. Axe checks each state in the light and dark themes.
 */

const API_URL = process.env.API_URL ?? "http://localhost:4000";
const DEMO_TENANT = "0194d000-0000-7000-8000-000000000001";
const HARBOUR_HOUSE = "0194d000-0000-7000-8000-000000000101";
const RUN = Date.now().toString(36);
const DAY = 86_400_000;

// Long journeys: many forms on one record, each checked with axe in two themes.
test.describe.configure({ mode: "serial", timeout: 240_000 });

// Sign in once per person (Better Auth throttles sign-ins) and reuse the sessions.
const sessions: Record<
  "manager" | "nurse" | "carer",
  Awaited<ReturnType<BrowserContext["cookies"]>>
> = {
  manager: [],
  nurse: [],
  carer: [],
};

test.beforeAll(async ({ browser }, testInfo) => {
  testInfo.setTimeout(180_000);
  for (const who of ["manager", "nurse", "carer"] as const) {
    const context = await browser.newContext({ baseURL: testInfo.project.use.baseURL });
    const page = await context.newPage();
    await signIn(page, `${who}@example.invalid`);
    sessions[who] = await context.cookies();
    await context.close();
  }
});

async function as(context: BrowserContext, who: keyof typeof sessions) {
  await context.clearCookies();
  await context.addCookies(sessions[who]);
}

async function api<T>(
  request: APIRequestContext,
  method: "get" | "post" | "put",
  path: string,
  data?: object,
): Promise<T> {
  const response = await request[method](`${API_URL}${path}`, {
    headers: { "x-harbour-tenant": DEMO_TENANT },
    ...(data ? { data } : {}),
  });
  expect(response.ok(), `${method} ${path} ${await response.text()}`).toBe(true);
  return (await response.json()) as T;
}

interface Person {
  readonly id: string;
  readonly version: number;
}
interface Assessment {
  readonly assessment: { readonly version: number } | null;
  readonly definitions: readonly { readonly key: string; readonly required: boolean }[];
}

/**
 * An enquiry made through the API by the manager, at pre-admission with every required section
 * recorded unless `sections` is false: for the journeys that start further on.
 */
async function assessedPerson(
  request: APIRequestContext,
  given: string,
  options: { readonly sections?: boolean } = {},
): Promise<string> {
  const person = await api<Person>(request, "post", "/v1/people", {
    locationId: HARBOUR_HOUSE,
    givenName: given,
    familyName: `Example-${RUN}`,
    dateOfBirth: "1940-04-04",
    receivedAt: new Date(Date.now() - 2 * DAY).toISOString(),
  });
  const services = await api<{ items: { id: string; serviceType: string }[] }>(
    request,
    "get",
    `/v1/locations/${HARBOUR_HOUSE}/services`,
  );
  await api(request, "post", `/v1/people/${person.id}/status`, {
    to: "pre_admission",
    effectiveAt: new Date(Date.now() - DAY).toISOString(),
    serviceId: services.items.find((s) => s.serviceType === "residential")?.id,
    placementTypeSought: "permanent",
    version: person.version,
  });
  if (options.sections !== false) await recordSections(request, person.id);
  return person.id;
}

/** Every required section not yet done, recorded as done, with the sources and involvement. */
async function recordSections(request: APIRequestContext, personId: string) {
  const view = await api<Assessment & { assessment: { sections: Record<string, unknown> } }>(
    request,
    "get",
    `/v1/people/${personId}/pre-admission`,
  );
  const sections = Object.fromEntries(
    view.definitions
      .filter((d) => d.required && !(d.key in (view.assessment?.sections ?? {})))
      .map((d) => [d.key, { status: "complete", notes: `Recorded with the person (${RUN}).` }]),
  );
  await api(request, "put", `/v1/people/${personId}/pre-admission`, {
    sections,
    informationSources: ["person", "family_or_representative"],
    personInvolvement: { involved: true },
    version: view.assessment?.version ?? 1,
  });
}

const main = (page: Page) => page.getByRole("main");
const arrival = (page: Page) => page.locator("[data-arrival-notice]");
const region = (page: Page, name: string) => main(page).getByRole("region", { name, exact: true });
const section = (page: Page, title: string) =>
  main(page).getByRole("article", { name: title, exact: true });

/** Axe in the light theme, then the dark theme. */
async function accessibleInBothThemes(page: Page, name: string) {
  await expectAccessible(page, `${name}, light theme`);
  await page.emulateMedia({ colorScheme: "dark" });
  await expectAccessible(page, `${name}, dark theme`);
  await page.emulateMedia({ colorScheme: "light" });
}

/**
 * Opens a form that opens in place from its button, once the page has hydrated: a click before
 * React has attached its handlers does nothing, so the click is repeated until the form shows.
 */
async function open(trigger: Locator, field: Locator) {
  await expect(async () => {
    if ((await trigger.isVisible()) && (await trigger.isEnabled())) {
      await trigger.click({ timeout: 2_000 });
    }
    await expect(field).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
}

/** Sends a form once the page has hydrated: repeated until what it shows appears. */
async function send(button: Locator, shown: Locator) {
  await expect(async () => {
    if (await button.isEnabled()) await button.click({ timeout: 2_000 });
    await expect(shown).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
}

async function fillDate(group: Locator, day: string, month: string, year: string) {
  await group.getByLabel("Day").fill(day);
  await group.getByLabel("Month").fill(month);
  await group.getByLabel("Year").fill(year);
}

test("hazard HZ-007 hazard HZ-015 hazard HZ-016 the manager records an enquiry, assesses and decides with reasons and a condition", async ({
  page,
  context,
}) => {
  await as(context, "manager");
  const family = `Newlands-${RUN}`;
  await page.goto("/people");
  await main(page).getByRole("link", { name: "Enquiries and pre-admission" }).click();
  await expect(
    main(page).getByRole("heading", { level: 1, name: "Enquiries and pre-admission" }),
  ).toBeVisible();
  await accessibleInBothThemes(page, "enquiries and pre-admission");

  await main(page).getByRole("link", { name: "Record an enquiry" }).click();
  await expect(
    main(page).getByRole("heading", { level: 1, name: "Record an enquiry" }),
  ).toBeVisible();
  // Nothing filled in: every problem at once, each linked to its field.
  const problems = main(page).getByRole("alert");
  await send(main(page).getByRole("button", { name: "Record the enquiry" }), problems);
  await expect(problems).toContainText("Enter the person's given name");
  await expect(problems).toContainText("Enter the person's family name");
  await expect(problems).toContainText("The date of birth must include a day, month and year");
  await expect(problems).toBeFocused();
  await accessibleInBothThemes(page, "enquiry form with problems");

  await main(page).getByLabel("Given name").fill("Ivy");
  await main(page).getByLabel("Family name").fill(family);
  await fillDate(main(page).getByRole("group", { name: "Date of birth" }), "7", "6", "1941");
  await main(page).getByRole("button", { name: "Record the enquiry" }).click();
  await page.waitForURL(/\/people\/[0-9a-f-]{36}\/pre-admission/);
  const personId = new URL(page.url()).pathname.split("/")[2] ?? "";
  await expect(arrival(page)).toContainText("Enquiry recorded");
  // The page title names the tab, never the person.
  await expect(page).toHaveTitle(/Pre-admission/);
  expect(await page.title()).not.toContain(family);
  // Not on the residents' list; on the enquiries list.
  await expect(region(page, "Enquiry")).toContainText("The assessment has not started");
  await accessibleInBothThemes(page, "a new enquiry");

  const enquiry = region(page, "Enquiry");
  await enquiry.getByLabel("Service sought").selectOption({ label: "Harbour House nursing" });
  await enquiry.getByRole("radio", { name: "Permanent" }).check();
  await enquiry.getByRole("button", { name: "Start the pre-admission assessment" }).click();
  await expect(arrival(page)).toContainText("Pre-admission assessment started");
  const assessment = region(page, "Pre-admission assessment");
  await expect(assessment).toContainText("Harbour House nursing");
  await expect(assessment).toContainText("Not finished");

  // Allergies are a safety fact (HZ-007): "not applicable" is never offered, and done needs words.
  const allergies = section(page, "Allergies and adverse reactions");
  await expect(allergies.getByText("Not started", { exact: true })).toBeVisible();
  await open(
    allergies.getByRole("button", { name: "Edit: Allergies and adverse reactions" }),
    allergies.getByRole("radio", { name: "Done" }),
  );
  await expect(allergies.getByRole("radio", { name: "Not applicable" })).toHaveCount(0);
  await expect(allergies).toContainText("This is a safety fact");
  await allergies.getByRole("radio", { name: "Done" }).check();
  await allergies.getByRole("button", { name: "Save section" }).click();
  await expect(allergies.getByRole("alert")).toContainText(
    "Write what was found before marking the section done",
  );
  await accessibleInBothThemes(page, "a safety section with a problem");
  await allergies
    .getByLabel("What was found")
    .fill(`No known allergies, confirmed with her GP practice (${RUN}).`);
  await allergies.getByRole("button", { name: "Save section" }).click();
  await expect(allergies.getByRole("status")).toContainText(
    "Saved: Allergies and adverse reactions",
  );
  await expect(allergies.getByText("Done", { exact: true })).toBeVisible();
  await expect(allergies).toContainText("by you");

  // Eating and drinking (IDDSI levels, HZ-016) is never "not applicable" either.
  const eating = section(page, "Eating, drinking and swallowing (IDDSI levels)");
  await open(
    eating.getByRole("button", { name: /^Edit:/ }),
    eating.getByRole("radio", { name: "Done" }),
  );
  await expect(eating.getByRole("radio", { name: "Not applicable" })).toHaveCount(0);
  await eating.getByRole("button", { name: "Cancel" }).click();
  await expect(eating.getByRole("button", { name: /^Edit:/ })).toBeFocused();

  // Nor is resuscitation (HZ-015): a decision, or that there is none, is recorded as known.
  const resuscitation = section(page, "Resuscitation decisions and advance care plans");
  await open(
    resuscitation.getByRole("button", { name: /^Edit:/ }),
    resuscitation.getByRole("radio", { name: "Done" }),
  );
  await expect(resuscitation.getByRole("radio", { name: "Not applicable" })).toHaveCount(0);
  await resuscitation.getByRole("button", { name: "Cancel" }).click();

  // The medicines list, with a time-critical medicine.
  const medicines = section(page, "Current medicines");
  await open(
    medicines.getByRole("button", { name: "Edit: Current medicines" }),
    medicines.getByRole("button", { name: "Add a medicine" }),
  );
  await medicines.getByRole("button", { name: "Add a medicine" }).click();
  const first = medicines.getByRole("group", { name: "Medicine 1" });
  await first.getByLabel("Medicine", { exact: true }).fill("Co-careldopa");
  await first.getByLabel("Dose").fill("25 mg/100 mg");
  await first.getByLabel("How it is taken").fill("By mouth");
  await first.getByLabel("How often").fill("Four times a day");
  await first.getByLabel(/Time-critical/).check();
  await medicines.getByRole("radio", { name: "Done" }).check();
  await medicines.getByRole("button", { name: "Save section" }).click();
  await expect(medicines.getByRole("status")).toContainText("Saved: Current medicines");
  await expect(medicines).toContainText("Co-careldopa, 25 mg/100 mg, By mouth, Four times a day");
  await expect(medicines.getByText("Time-critical", { exact: true })).toBeVisible();

  // Equipment may be not applicable, with a reason.
  const equipment = section(page, "Equipment needed");
  await open(
    equipment.getByRole("button", { name: "Edit: Equipment needed" }),
    equipment.getByRole("radio", { name: "Not applicable" }),
  );
  await equipment.getByRole("radio", { name: "Not applicable" }).check();
  await equipment.getByLabel("Why this section does not apply").fill("Walks without aids");
  await equipment.getByRole("button", { name: "Save section" }).click();
  await expect(equipment.getByRole("status")).toContainText("Saved: Equipment needed");
  await expect(equipment).toContainText("Not applicable: Walks without aids");

  // No decision until every section, the sources and the person's involvement are recorded.
  const decision = region(page, "Decision to admit");
  await expect(decision).toContainText("Finish every required section");
  await recordSections(page.request, personId);
  await page.reload();
  await expect(region(page, "Pre-admission assessment")).toContainText("Ready for a decision");
  const sources = region(page, "Where the information came from");
  await open(
    sources.getByRole("button", { name: "Record sources and how the person took part" }),
    sources.getByRole("checkbox", { name: "GP" }),
  );
  await sources.getByRole("checkbox", { name: "GP" }).check();
  await sources.getByRole("button", { name: "Save", exact: true }).click();
  await expect(sources.getByRole("status")).toContainText("Sources and involvement saved");
  await expect(sources).toContainText("From: The person, Family or representative, GP.");
  await accessibleInBothThemes(page, "a finished assessment");

  // The decision: reasons of a sentence or more, and the condition when conditional.
  await decision.getByRole("radio", { name: "Can meet needs with conditions" }).check();
  await decision.getByLabel("Reasons for the decision").fill("Fine.");
  await decision.getByRole("button", { name: "Record the decision" }).click();
  const refused = decision.getByRole("alert");
  await expect(refused).toContainText("Give the reasons in 20 characters or more");
  await expect(refused).toContainText("List at least one condition");
  await accessibleInBothThemes(page, "a decision with problems");
  await decision
    .getByLabel("Reasons for the decision")
    .fill(
      `The nursing unit can meet her needs once a pressure-relieving mattress is in place (${RUN}).`,
    );
  await decision.getByLabel("Condition 1").fill(`Pressure-relieving mattress in place (${RUN})`);
  await decision.getByRole("button", { name: "Record the decision" }).click();
  await expect(decision.getByRole("status").filter({ hasText: "Decision recorded" })).toBeVisible();
  const made = decision.getByRole("article").first();
  await expect(made.getByText("Can meet needs with conditions", { exact: true })).toBeVisible();
  await expect(made).toContainText(`Pressure-relieving mattress in place (${RUN})`);
  await expect(made.getByText("Not met yet", { exact: true })).toBeVisible();
  await expect(made).toContainText("by you");
  // Admission waits for the condition.
  await expect(decision.getByRole("link", { name: "Record the admission" })).toHaveCount(0);

  await made.getByRole("button", { name: "Confirm condition 1 is met" }).click();
  await expect(made.getByRole("status")).toContainText("Condition confirmed as met");
  await expect(made.getByText(/^Met .* by you$/)).toBeVisible();
  await expect(decision.getByRole("link", { name: "Record the admission" })).toBeVisible();
  await accessibleInBothThemes(page, "a decision with its condition met");

  // On the enquiries list, not on the residents' list.
  await page.goto("/people/pre-admission");
  await expect(region(page, "Enquiries and assessments in progress")).toContainText(family);
  await page.goto("/people");
  await expect(main(page).getByText(family)).toHaveCount(0);
});

test("a declined decision replaces the earlier one, struck through, and the enquiry closes as not admitted", async ({
  page,
  context,
}) => {
  await as(context, "manager");
  const personId = await assessedPerson(page.request, "Rose");
  await api(page.request, "post", `/v1/people/${personId}/admission-decisions`, {
    canMeetNeeds: "yes",
    reasons: `The residential unit can meet her needs as assessed (${RUN}).`,
  });
  await page.goto(`/people/${personId}/pre-admission`);
  const decision = region(page, "Decision to admit");
  await expect(decision.getByText("Can meet needs", { exact: true })).toBeVisible();

  await open(
    decision.getByRole("button", { name: "Record a new decision" }),
    decision.getByLabel("Why the earlier decision is being replaced"),
  );
  await expect(decision.getByLabel("Why the earlier decision is being replaced")).toBeFocused();
  await decision
    .getByLabel("Why the earlier decision is being replaced")
    .fill("The hospital discharge summary showed new nursing needs.");
  await decision.getByRole("radio", { name: "Cannot meet needs" }).check();
  await decision
    .getByLabel("Reasons for the decision")
    .fill(`She now needs nursing care the residential unit cannot give (${RUN}).`);
  await decision.getByRole("button", { name: "Record the decision" }).click();
  await expect(decision.getByRole("status").filter({ hasText: "Decision recorded" })).toBeVisible();
  await expect(
    decision.getByRole("article").first().getByText("Cannot meet needs", { exact: true }),
  ).toBeVisible();
  await expect(decision).toContainText("Close the enquiry as not admitted");
  // The earlier decision stays, marked replaced and struck through (master prompt 5.5).
  const earlier = decision.getByRole("article", { name: /replaced$/ });
  await expect(earlier.getByText("Replaced", { exact: true })).toBeVisible();
  await expect(earlier.getByText(/The residential unit can meet her needs/)).toHaveCSS(
    "text-decoration-line",
    "line-through",
  );
  await accessibleInBothThemes(page, "a replaced decision");

  const enquiry = region(page, "Enquiry");
  await open(
    enquiry.getByRole("button", { name: "Close as not admitted" }),
    enquiry.getByLabel("Why the person is not being admitted"),
  );
  await expect(enquiry).toContainText("nothing more can be added to it");
  await enquiry.getByRole("button", { name: "Close as not admitted" }).click();
  await expect(enquiry.getByRole("alert")).toContainText("Give the reason in 3 characters or more");
  await enquiry
    .getByLabel("Why the person is not being admitted")
    .fill("The home cannot meet her nursing needs; the family were told.");
  await enquiry.getByRole("button", { name: "Close as not admitted" }).click();
  await page.waitForURL(/\/people\/pre-admission\?done=closed/);
  await expect(arrival(page)).toContainText("The enquiry was closed as not admitted.");
  const closed = region(page, "Not admitted")
    .getByRole("listitem")
    .filter({ hasText: "Rose" })
    .filter({
      hasText: `Example-${RUN}`,
    });
  await expect(closed.getByText("Not admitted", { exact: true })).toBeVisible();
  await accessibleInBothThemes(page, "an enquiry closed as not admitted");
});

test("the nurse writes sections but never decides; a care worker is not offered enquiries", async ({
  page,
  context,
}) => {
  await as(context, "manager");
  const personId = await assessedPerson(page.request, "Mae", { sections: false });

  await as(context, "nurse");
  await page.goto("/people");
  await main(page).getByRole("link", { name: "Enquiries and pre-admission" }).click();
  await expect(main(page).getByRole("link", { name: "Record an enquiry" })).toHaveCount(0);
  await page.goto(`/people/${personId}/pre-admission`);
  await expect(
    main(page).getByRole("button", { name: "Edit: Allergies and adverse reactions" }),
  ).toBeVisible();
  await expect(region(page, "Decision to admit").getByRole("button")).toHaveCount(0);
  await expect(region(page, "Enquiry").getByRole("button")).toHaveCount(0);
  await accessibleInBothThemes(page, "the pre-admission tab for a nurse");
  await page.goto("/people/pre-admission/new");
  await expect(main(page).getByText("You do not have access to this.")).toBeVisible();

  await as(context, "carer");
  await page.goto("/people");
  await expect(main(page).getByRole("link", { name: "Enquiries and pre-admission" })).toHaveCount(
    0,
  );
  await page.goto("/people/pre-admission");
  await expect(main(page).getByText("You do not have access to this.")).toBeVisible();
});
