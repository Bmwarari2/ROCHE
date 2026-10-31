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
 * Admission, rooms and beds, the welcome checklist, property and keys (PEOP-007; people.md rules
 * 5 to 7; hazards HZ-001, HZ-007 and HZ-016) against the demo tenant. The Registered
 * Manager admits a person this run assessed and decided on through the API into a free bed from
 * yesterday, moves them today (the header's room follows the move history), works the welcome
 * checklist (safety-critical items first, never "not applicable"), records glasses and a ring in
 * (the ring witnessed by the nurse, found by name, never by the manager), returns the glasses and
 * issues and takes back a key. The nurse ticks the checklist but is offered no move. Each run makes
 * its own person, named with the run (invented, no NHS number), and takes beds that are free on
 * the board: no demo resident's room changes. Axe checks each state in the light and dark themes.
 */

const API_URL = process.env.API_URL ?? "http://localhost:4000";
const DEMO_TENANT = "0194d000-0000-7000-8000-000000000001";
const HARBOUR_HOUSE = "0194d000-0000-7000-8000-000000000101";
const RUN = Date.now().toString(36);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const FAMILY = `Bedford-${RUN}`;

// Long journeys: many forms on one record, each checked with axe in two themes.
test.describe.configure({ mode: "serial", timeout: 300_000 });

const sessions: Record<"manager" | "nurse", Awaited<ReturnType<BrowserContext["cookies"]>>> = {
  manager: [],
  nurse: [],
};
let personId = "";

test.beforeAll(async ({ browser }, testInfo) => {
  testInfo.setTimeout(180_000);
  for (const who of ["manager", "nurse"] as const) {
    const context = await browser.newContext({ baseURL: testInfo.project.use.baseURL });
    const page = await context.newPage();
    await signIn(page, `${who}@example.invalid`);
    sessions[who] = await context.cookies();
    await context.close();
  }
});

/**
 * The person this run admitted leaves again (a discharge home, which releases their bed), so later
 * journeys and runs find the home as it was. Their record stays, as discharged records do.
 */
test.afterAll(async ({ browser }, testInfo) => {
  if (!personId) return;
  const context = await browser.newContext({ baseURL: testInfo.project.use.baseURL });
  await context.addCookies(sessions.manager);
  const person = await api<{ status: string; version: number }>(
    context.request,
    "get",
    `/v1/people/${personId}`,
  );
  if (person.status === "active") {
    await api(context.request, "post", `/v1/people/${personId}/status`, {
      to: "discharged",
      effectiveAt: new Date().toISOString(),
      reason: `End of the admission journey (${RUN})`,
      exitKind: "discharge",
      exit: { destinationType: "own_home" },
      version: person.version,
    });
  }
  await context.close();
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

/** A UK calendar day `offset` days from today, as the boxes and dd/mm/yyyy show it. */
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
  return {
    day: parts.day ?? "",
    month: parts.month ?? "",
    year: parts.year ?? "",
    iso: `${parts.year}-${parts.month}-${parts.day}`,
    shown: `${parts.day}/${parts.month}/${parts.year}`,
  };
}

/**
 * A person this run made through the API: an enquiry from three days ago, assessed from two days
 * ago with every required section, and a decision that the home can meet their needs.
 */
async function decidedPerson(request: APIRequestContext): Promise<string> {
  const person = await api<{ id: string; version: number }>(request, "post", "/v1/people", {
    locationId: HARBOUR_HOUSE,
    givenName: "Iris",
    familyName: FAMILY,
    dateOfBirth: "1939-09-09",
    receivedAt: new Date(Date.now() - 3 * DAY).toISOString(),
  });
  const services = await api<{ items: { id: string; serviceType: string }[] }>(
    request,
    "get",
    `/v1/locations/${HARBOUR_HOUSE}/services`,
  );
  await api(request, "post", `/v1/people/${person.id}/status`, {
    to: "pre_admission",
    effectiveAt: new Date(Date.now() - 2 * DAY).toISOString(),
    serviceId: services.items.find((s) => s.serviceType === "residential")?.id,
    placementTypeSought: "permanent",
    version: person.version,
  });
  const view = await api<{
    assessment: { version: number };
    definitions: { key: string; required: boolean }[];
  }>(request, "get", `/v1/people/${person.id}/pre-admission`);
  await api(request, "put", `/v1/people/${person.id}/pre-admission`, {
    sections: Object.fromEntries(
      view.definitions
        .filter((d) => d.required)
        .map((d) => [d.key, { status: "complete", notes: `Recorded with Iris (${RUN}).` }]),
    ),
    informationSources: ["person"],
    personInvolvement: { involved: true },
    version: view.assessment.version,
  });
  await api(request, "post", `/v1/people/${person.id}/admission-decisions`, {
    canMeetNeeds: "yes",
    reasons: `The residential unit can meet every need the assessment found (${RUN}).`,
  });
  return person.id;
}

const main = (page: Page) => page.getByRole("main");
const arrival = (page: Page) => page.locator("[data-arrival-notice]");
const region = (page: Page, name: string) => main(page).getByRole("region", { name, exact: true });
const header = (page: Page) => main(page).getByRole("region", { name: "Person details" });

async function accessibleInBothThemes(page: Page, name: string) {
  await expectAccessible(page, `${name}, light theme`);
  await page.emulateMedia({ colorScheme: "dark" });
  await expectAccessible(page, `${name}, dark theme`);
  await page.emulateMedia({ colorScheme: "light" });
}

/** Opens a form in place once the page has hydrated (a click before then does nothing). */
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

async function fillDate(group: Locator, day: { day: string; month: string; year: string }) {
  await group.getByLabel("Day", { exact: true }).fill(day.day);
  await group.getByLabel("Month", { exact: true }).fill(day.month);
  await group.getByLabel("Year", { exact: true }).fill(day.year);
}

interface Board {
  readonly rooms: readonly {
    readonly roomId: string;
    readonly beds: readonly { readonly bed: number; readonly occupied: boolean }[];
  }[];
}

/**
 * Chooses a bed the select offers (free today) that was also free on `alsoFreeOn` (yyyy-mm-dd),
 * read from the bed board: a bed someone left today was still theirs yesterday. Says which room.
 */
async function freeBed(
  request: APIRequestContext,
  select: Locator,
  alsoFreeOn: string | null,
): Promise<string> {
  let free: Set<string> | null = null;
  if (alsoFreeOn) {
    const board = await api<Board>(
      request,
      "get",
      `/v1/locations/${HARBOUR_HOUSE}/beds?date=${alsoFreeOn}`,
    );
    free = new Set(
      board.rooms.flatMap((r) =>
        r.beds.filter((b) => !b.occupied).map((b) => `${r.roomId}:${b.bed}`),
      ),
    );
  }
  const values = await select
    .locator("option")
    .evaluateAll((options) => options.map((o) => (o as HTMLOptionElement).value).filter(Boolean));
  const value = values.find((v) => free === null || free.has(v));
  expect(value, "a free bed on the board").toBeTruthy();
  await select.selectOption(value ?? "");
  return ((await select.locator("option:checked").textContent()) ?? "").trim();
}

test("hazard HZ-001 the manager admits into a free bed and moves the person; the header follows the move history", async ({
  page,
  context,
}) => {
  await as(context, "manager");
  personId = await decidedPerson(page.request);
  await page.goto(`/people/${personId}/admission`);
  await expect(page).toHaveTitle(/Admission and room/);
  expect(await page.title()).not.toContain(FAMILY);
  const admit = region(page, "Admission");
  await expect(admit.getByLabel("Service")).toHaveValue(/.+/);
  await expect(admit.getByRole("radio", { name: "Permanent" })).toBeChecked();
  await accessibleInBothThemes(page, "the admission form");

  // Nothing chosen for the bed: refused at the field, with the summary linking to it.
  await send(admit.getByRole("button", { name: "Record the admission" }), admit.getByRole("alert"));
  await expect(admit.getByRole("alert")).toContainText("Choose a room and bed");
  await expect(admit.getByRole("alert")).toBeFocused();

  const yesterday = ukDay(-1);
  await fillDate(admit.getByRole("group", { name: "First day of the placement" }), yesterday);
  const first = await freeBed(page.request, admit.getByLabel("Room and bed"), yesterday.iso);
  await admit.getByRole("radio", { name: /^Earlier/ }).check();
  const arrived = admit.getByRole("group", { name: "Date and time it happened" });
  await fillDate(arrived, yesterday);
  await arrived.getByLabel("Hour", { exact: true }).fill("14");
  await arrived.getByLabel("Minute", { exact: true }).fill("00");
  await admit.getByRole("button", { name: "Record the admission" }).click();
  await expect(arrival(page)).toContainText("Admission recorded");
  const room = region(page, "Room and bed");
  await expect(room.locator("[data-current-room]")).toHaveText(
    `${first}, since ${yesterday.shown}`,
  );
  // The point-of-care header names the room from the bed history (HZ-001).
  await expect(header(page)).toContainText(first);
  await expect(region(page, "Placement")).toContainText("Permanent");
  await expect(region(page, "Placement")).toContainText(yesterday.shown);
  await accessibleInBothThemes(page, "an admitted person");

  // A move needs a reason; then the history keeps both beds, the earlier one closed today.
  await open(
    room.getByRole("button", { name: "Move to another room" }),
    room.getByLabel("Move to"),
  );
  await expect(room.getByLabel("Move to")).toBeFocused();
  const second = await freeBed(page.request, room.getByLabel("Move to"), null);
  expect(second).not.toBe(first);
  await room.getByRole("button", { name: "Record the move" }).click();
  await expect(room.getByRole("alert")).toContainText("Give the reason for the move");
  await accessibleInBothThemes(page, "a move with a problem");
  await room.getByLabel("Reason for the move").fill(`Asked for a room nearer the garden (${RUN})`);
  await room.getByRole("button", { name: "Record the move" }).click();
  await expect(room.getByRole("status").filter({ hasText: "Move recorded" })).toBeVisible();
  const today = ukDay(0);
  await expect(room.locator("[data-current-room]")).toHaveText(`${second}, since ${today.shown}`);
  const history = room.getByRole("region", { name: "Move history" }).getByRole("listitem");
  await expect(history).toHaveCount(2);
  await expect(history.first()).toContainText("still here");
  await expect(history.first()).toContainText(`Asked for a room nearer the garden (${RUN})`);
  await expect(history.nth(1)).toContainText(`From ${yesterday.shown} to ${today.shown}`);
  await expect(history.nth(1).getByText("Recorded after the day", { exact: true })).toBeVisible();
  await page.reload();
  await expect(header(page)).toContainText(second);
  await accessibleInBothThemes(page, "the move history");
});

test("hazard HZ-007 hazard HZ-016 the welcome checklist lists safety-critical items first and never lets them be not applicable", async ({
  page,
  context,
}) => {
  test.skip(!personId, "needs the admitted person");
  await as(context, "manager");
  await page.goto(`/people/${personId}/admission`);
  const checklist = region(page, "Welcome checklist");
  await expect(checklist).toContainText("5 safety-critical items are still to do");
  const items = checklist.getByRole("listitem");
  await expect(items.first()).toContainText("Photo taken for identification");
  await expect(items.first().getByText("Safety-critical", { exact: true })).toBeVisible();
  // Allergies (HZ-007) and the kitchen's IDDSI levels (HZ-016) can only be done.
  const allergies = items.filter({ hasText: "Allergies confirmed and recorded" });
  await expect(allergies.getByRole("button", { name: /^Not applicable/ })).toHaveCount(0);
  const diet = items.filter({ hasText: "IDDSI levels shared with the kitchen" });
  await expect(diet.getByRole("button", { name: /^Not applicable/ })).toHaveCount(0);

  const photo = items.filter({ hasText: "Photo taken for identification" });
  await open(
    photo.getByRole("button", { name: "Done: Photo taken for identification" }),
    photo.getByText(/^Recorded .* by you$/),
  );
  await expect(checklist).toContainText("4 safety-critical items are still to do");

  const bell = items.filter({ hasText: "Call bell explained and within reach" });
  await open(
    bell.getByRole("button", { name: "Not applicable: Call bell explained and within reach" }),
    bell.getByLabel("Why this does not apply: Call bell explained and within reach"),
  );
  await bell.getByRole("button", { name: "Mark not applicable" }).click();
  await expect(bell.getByRole("alert")).toContainText("Say why this does not apply");
  await bell
    .getByLabel("Why this does not apply: Call bell explained and within reach")
    .fill("Uses a pendant alarm she wears");
  await bell.getByRole("button", { name: "Mark not applicable" }).click();
  await expect(bell.getByText("Not applicable: Uses a pendant alarm she wears")).toBeVisible();
  await expect(bell.getByText("Not applicable", { exact: true })).toBeVisible();
  await accessibleInBothThemes(page, "the welcome checklist");
  await bell
    .getByRole("button", { name: "Put back to do: Call bell explained and within reach" })
    .click();
  await expect(bell.getByText("To do", { exact: true })).toBeVisible();

  // The nurse ticks the checklist but is offered no move (people.admission.manage).
  await as(context, "nurse");
  await page.goto(`/people/${personId}/admission`);
  await expect(
    region(page, "Welcome checklist").getByRole("button", { name: /^Done: Allergies/ }),
  ).toBeVisible();
  await expect(region(page, "Room and bed").getByRole("button")).toHaveCount(0);
});

test("property in and out: valuables witnessed by a colleague, glasses returned, a key issued and back", async ({
  page,
  context,
}) => {
  test.skip(!personId, "needs the admitted person");
  await as(context, "manager");
  await page.goto(`/people/${personId}/property`);
  await expect(page).toHaveTitle(/Property and keys/);
  await expect(region(page, "Held now")).toContainText("No property is held for this person.");
  await accessibleInBothThemes(page, "an empty inventory");

  const add = region(page, "Record an item in");
  const glasses = `Reading glasses in a brown case (${RUN})`;
  await add.getByLabel("Description").fill(glasses);
  await add.getByLabel("Category").selectOption({ label: "Glasses or hearing aid" });
  await expect(add).toContainText("offered to go with the person to hospital");
  await add.getByRole("radio", { name: "The person signed" }).check();
  await add.getByLabel("Name the person typed").fill("Iris Example");
  await add.getByRole("button", { name: "Record the item" }).click();
  await expect(add.getByRole("status")).toContainText("Item recorded");
  const held = region(page, "Held now");
  const glassesItem = held.getByRole("article", { name: `${glasses} (1 item)` });
  await expect(glassesItem.getByText("Held", { exact: true })).toBeVisible();
  await expect(
    glassesItem.getByText("Goes to hospital with the person", { exact: true }),
  ).toBeVisible();

  // A valuable needs a second member of staff: never the person recording.
  const ring = `Gold ring with a blue stone (${RUN})`;
  await add.getByLabel("Description").fill(ring);
  await add.getByLabel("Category").selectOption({ label: "Jewellery" });
  await expect(add.getByRole("checkbox", { name: "A valuable" })).toBeChecked();
  await add.getByRole("radio", { name: "Their representative signed" }).check();
  await add.getByLabel("Name the representative typed").fill("Rob Example");
  await add.getByRole("button", { name: "Record the item" }).click();
  await expect(add.getByRole("alert")).toContainText("Choose a colleague who witnessed it");
  await accessibleInBothThemes(page, "a valuable without its witness");
  const witness = add.getByRole("group", { name: "Witness" });
  await witness.getByLabel("Colleague's name").fill("Mo Manager");
  await witness.getByRole("button", { name: "Find colleague" }).click();
  // The manager recording it is never offered as the witness.
  await expect(witness.getByText(/No colleague found with that name/)).toBeVisible();
  await witness.getByLabel("Colleague's name").fill("Nell");
  await witness.getByRole("button", { name: "Find colleague" }).click();
  await witness.getByRole("radio", { name: /Nell Nurse/ }).check();
  await add.getByRole("button", { name: "Record the item" }).click();
  await expect(add.getByRole("status").filter({ hasText: "Item recorded" })).toBeVisible();
  const ringItem = held.getByRole("article", { name: `${ring} (1 item)` });
  await expect(ringItem.getByText("Valuable", { exact: true })).toBeVisible();
  await expect(ringItem).toContainText("By their representative: Rob Example");
  await expect(ringItem).toContainText("A colleague");
  await accessibleInBothThemes(page, "an inventory with a valuable");

  // A lost item needs its incident first.
  await open(
    ringItem.getByRole("button", { name: `Record as lost: ${ring}` }),
    ringItem.getByText(/Record the incident for the lost item first/),
  );
  await ringItem.getByRole("button", { name: "Cancel" }).click();

  // The glasses go back to the person, who signs.
  await open(
    glassesItem.getByRole("button", { name: `Return: ${glasses}` }),
    glassesItem.getByLabel("Name of who received it"),
  );
  await glassesItem.getByLabel("Name of who received it").fill("Iris Example");
  await glassesItem.getByRole("radio", { name: "The person", exact: true }).check();
  await glassesItem.getByRole("radio", { name: "The person signed" }).check();
  await glassesItem.getByLabel("Name the person typed").fill("Iris Example");
  await glassesItem.getByRole("button", { name: "Record the return" }).click();
  await expect(arrival(page)).toContainText("Item returned.");
  const back = region(page, "Returned, disposed of or lost").getByRole("article", {
    name: `${glasses} (1 item)`,
  });
  await expect(back.getByText("Returned", { exact: true }).first()).toBeVisible();
  await expect(back).toContainText("to Iris Example (the person)");
  await expect(held.getByRole("article", { name: `${glasses} (1 item)` })).toHaveCount(0);

  // A key out, then back.
  const keys = region(page, "Keys and fobs");
  const label = `Room door key (${RUN})`;
  await keys.getByRole("textbox", { name: "Key or fob" }).fill(label);
  await keys.getByRole("radio", { name: "The person" }).check();
  await keys.getByRole("button", { name: "Issue the key" }).click();
  await expect(keys.getByRole("status").filter({ hasText: "Key issued" })).toBeVisible();
  const key = keys.getByRole("listitem").filter({ hasText: label });
  await expect(key.getByText("Out", { exact: true })).toBeVisible();
  await open(
    key.getByRole("button", { name: `Returned: ${label}` }),
    key.getByRole("group", { name: "Day it came back" }),
  );
  await key.getByRole("button", { name: "Record the return" }).click();
  await expect(arrival(page)).toContainText("Key recorded as returned.");
  await expect(
    region(page, "Keys and fobs")
      .getByRole("listitem")
      .filter({ hasText: label })
      .getByText("Returned", {
        exact: true,
      }),
  ).toBeVisible();
  await accessibleInBothThemes(page, "property and keys after returns");
});
