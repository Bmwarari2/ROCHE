import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import { expectAccessible, openModules, signIn } from "./support";

/**
 * Slice 5 web: the shift handover (care.md rule 14; COMMS-006; hazards HZ-001, HZ-008) against the
 * demo tenant. The nurse compiles the shift running now (or opens it when an earlier attempt or
 * journey compiled it), writes a note on it, and acknowledges it as shown; the carer opens it and
 * is told they have not acknowledged it yet. Each attempt's note carries its own run mark. Every
 * state is checked with axe.
 */

const API_URL = process.env.API_URL ?? "http://localhost:4000";
const DEMO_TENANT = "0194d000-0000-7000-8000-000000000001";
const DEMO_LOCATION = "0194d000-0000-7000-8000-000000000101";
const RUN = `run ${Date.now().toString(36)}`;

test.describe.configure({ mode: "serial" });

const sessions: Record<string, Awaited<ReturnType<BrowserContext["cookies"]>>> = {};

test.beforeAll(async ({ browser }, testInfo) => {
  // Two sign-ins one after another: room beyond one test's default.
  test.setTimeout(180_000);
  for (const user of ["nurse", "carer"]) {
    const context = await browser.newContext({ baseURL: testInfo.project.use.baseURL });
    await signIn(await context.newPage(), `${user}@example.invalid`);
    sessions[user] = await context.cookies();
    await context.close();
  }
});

async function as(context: BrowserContext, user: string) {
  await context.clearCookies();
  await context.addCookies(sessions[user] ?? []);
}

const main = (page: Page) => page.getByRole("main");
const alertIn = (page: Page) => main(page).getByRole("alert");

/** Opens this shift's handover, compiling it when nobody has yet. */
async function openThisShift(page: Page) {
  await page.goto(`/handover/${DEMO_LOCATION}`);
  await expect(page.getByRole("heading", { level: 1, name: "Handover" })).toBeVisible();
  const thisShift = page.getByRole("region", { name: "This shift" });
  const compile = thisShift.getByRole("button", { name: "Compile this shift's handover" });
  if (await compile.isVisible()) {
    await expectAccessible(page, "handover not compiled");
    await compile.click();
    await page.waitForURL(/\/handover\/[^/]+\/[^/?]+\?done=compiled&at=\d+$/);
    await expect(page.locator("[data-arrival-notice]")).toHaveText("Handover compiled.");
  } else {
    await thisShift
      .locator(`a[href^="/handover/${DEMO_LOCATION}/"]:not([href$="/new"])`)
      .first()
      .click();
    await page.waitForURL(/\/handover\/[^/]+\/[^/?]+$/);
  }
  await expect(page.getByRole("region", { name: "Items" })).toBeVisible();
}

test("hazard HZ-008 the nurse compiles this shift's handover, adds a note and acknowledges it", async ({
  page,
  context,
  playwright,
}) => {
  await as(context, "nurse");
  await page.goto("/");
  await (await openModules(page)).getByRole("link", { name: "Handover" }).click();
  await page.waitForURL((url) => url.pathname.startsWith("/handover"));
  await openThisShift(page);
  await expectAccessible(page, "handover");
  // The location's list, with this shift compiled.
  await page.goto(`/handover/${DEMO_LOCATION}`);
  await expect(
    page.getByRole("region", { name: "This shift" }).getByRole("heading", { level: 3 }),
  ).toBeVisible();
  await expectAccessible(page, "handover list compiled");
  await page.goBack();
  await expect(page.getByRole("region", { name: "Items" })).toBeVisible();

  // A note on the whole handover: an empty one is refused, the summary takes focus.
  const general = page.getByRole("region", { name: "Notes on the whole handover" });
  await general.getByRole("button", { name: "Add a note to the handover" }).click();
  await expect(general.getByLabel("Note", { exact: true })).toBeFocused();
  await general.getByRole("button", { name: "Save note" }).click();
  await expect(alertIn(page)).toBeFocused();
  await expect(alertIn(page)).toContainText("Write the note");
  await expectAccessible(page, "handover note refused");
  await general.getByLabel("Note", { exact: true }).fill(`Ada slept well (${RUN}).`);
  await general.getByRole("button", { name: "Save note" }).click();
  await expect(general.getByText(`Ada slept well (${RUN}).`)).toBeVisible();
  await expectAccessible(page, "handover note added");

  // HZ-018: an incident recorded and compiled after the page was opened makes the page stale;
  // acknowledging it is refused, the page reloads with the item marked new and says so.
  const handoverId = new URL(page.url()).pathname.split("/").at(-1) ?? "";
  // The carer records it and compiles again (compiling is limited per member a minute).
  const carer = await playwright.request.newContext({
    baseURL: API_URL,
    storageState: { cookies: sessions.carer ?? [], origins: [] },
  });
  const incident = await carer.post(`${API_URL}/v1/incidents`, {
    headers: { "x-harbour-tenant": DEMO_TENANT },
    data: {
      locationId: DEMO_LOCATION,
      occurredAt: new Date(Date.now() - 60_000).toISOString(),
      type: "environmental",
      description: `A light in the corridor failed (${RUN}).`,
    },
  });
  expect(incident.status(), await incident.text()).toBe(201);
  const compiled = await carer.post(`${API_URL}/v1/locations/${DEMO_LOCATION}/handovers`, {
    headers: { "x-harbour-tenant": DEMO_TENANT },
    data: {},
  });
  expect(compiled.status(), await compiled.text()).toBe(200);
  await carer.dispose();
  const read = page.getByRole("region", { name: "Who has read it" });
  await read.getByRole("button", { name: "I have read this handover" }).click();
  await expect(alertIn(page)).toBeFocused();
  await expect(alertIn(page)).toContainText("Items were added since you opened the handover.");
  await expect(main(page).getByText("New to you", { exact: true }).first()).toBeVisible();
  await expectAccessible(page, "handover changed since opened");
  expect(new URL(page.url()).pathname.endsWith(handoverId)).toBe(true);

  // A note on the incident the carer recorded, named for what it is about. It joined the handover
  // as a late addition, so it is the last incident item.
  const incidentItem = page
    .locator('[data-handover-item="incident"]')
    .filter({ has: page.getByText("Added since it was compiled", { exact: true }) })
    .last();
  const itemNote = incidentItem.getByRole("button", {
    name: "Add a note about this item (Incident)",
  });
  await expect(itemNote).toBeVisible();
  await itemNote.click();
  await incidentItem
    .getByLabel("Note", { exact: true })
    .fill(`Checked by the night nurse (${RUN}).`);
  await incidentItem.getByRole("button", { name: "Save note" }).click();
  await expect(incidentItem.getByText(`Checked by the night nurse (${RUN}).`)).toBeVisible();
  await expectAccessible(page, "item note added");

  // Acknowledged as shown: the page says so and where the nurse now stands.
  await read.getByRole("button", { name: "I have read this handover" }).click();
  await page.waitForURL(/\?done=acknowledged&at=\d+$/);
  await expect(page.locator("[data-arrival-notice]")).toHaveText("Handover acknowledged.");
  await expect(main(page).getByText("You have acknowledged it", { exact: true })).toBeVisible();
  await expect(read.getByText(/^Nell Nurse/)).toBeVisible();
  await expectAccessible(page, "handover acknowledged");
});

test("the carer opens the handover and is told it is still to acknowledge", async ({
  page,
  context,
}) => {
  await as(context, "carer");
  await openThisShift(page);
  await expect(
    main(page).getByText(/^(You have not acknowledged it yet|\d+ items? new to you)$/),
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Who has read it" }).getByRole("button", {
      name: "I have read this handover",
    }),
  ).toBeVisible();
  await expectAccessible(page, "handover for the carer");
});
