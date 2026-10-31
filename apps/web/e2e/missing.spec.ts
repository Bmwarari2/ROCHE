import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import { demoPerson, expectAccessible, signIn } from "./support";

/**
 * Phase 2 slice 63: the missing person screens and the Herbert Protocol profile against the demo
 * tenant (SAFE-015; HZ-127). The manager records a missing person incident through the API, opens
 * the episode from it, sees the police call target first, records the police called with their
 * reference, and opens the person's Herbert profile tab. Each run marks what it writes with the
 * run. Invented people and words only.
 */

const API_URL = process.env.API_URL ?? "http://localhost:4000";
const DEMO_TENANT = "0194d000-0000-7000-8000-000000000001";
const DEMO_LOCATION = "0194d000-0000-7000-8000-000000000101";
const RUN = `run ${Date.now().toString(36)}`;

test.describe.configure({ mode: "serial" });

let session: Awaited<ReturnType<BrowserContext["cookies"]>> = [];

test.beforeAll(async ({ browser }, testInfo) => {
  const context = await browser.newContext({ baseURL: testInfo.project.use.baseURL });
  await signIn(await context.newPage(), "manager@example.invalid");
  session = await context.cookies();
  await context.close();
});

async function accessibleInBothThemes(page: Page, name: string) {
  await page.emulateMedia({ colorScheme: "dark" });
  await expectAccessible(page, `${name} (dark)`);
  await page.emulateMedia({ colorScheme: "light" });
  await expectAccessible(page, `${name} (light)`);
}

/** Fills a date and time field's boxes, found by the field's legend, in UK time. */
async function fillWhen(page: Page, legend: string, at: Date) {
  const group = page.getByRole("group", { name: legend });
  const uk = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const part = (type: string) => uk.find((p) => p.type === type)?.value ?? "";
  await group.getByLabel("Day").fill(part("day"));
  await group.getByLabel("Month").fill(part("month"));
  await group.getByLabel("Year").fill(part("year"));
  await group.getByLabel("Hour").fill(part("hour"));
  await group.getByLabel("Minute").fill(part("minute"));
}

test("SAFE-015 the manager opens a missing person episode with the police call first, and calls the police", async ({
  page,
  context,
}) => {
  test.setTimeout(180_000);
  await context.addCookies(session);
  // One open episode per person, and a run leaves its episode open (closing needs the person
  // found, checked and debriefed), so each run takes a resident with none open.
  const listed = await context.request.get(`${API_URL}/v1/missing-episodes`, {
    headers: { "x-harbour-tenant": DEMO_TENANT },
  });
  expect(listed.status(), await listed.text()).toBe(200);
  const busy = new Set(
    ((await listed.json()) as { items: { personId: string; status: string }[] }).items
      .filter((e) => e.status !== "closed")
      .map((e) => e.personId),
  );
  const person = [1, 2, 3, 4, 5, 6].map(demoPerson).find((p) => !busy.has(p));
  test.skip(!person, "Every demo resident already has an open missing person episode.");
  if (!person) return;
  const noticed = new Date(Date.now() - 10 * 60_000);
  const recorded = await context.request.post(`${API_URL}/v1/incidents`, {
    headers: { "x-harbour-tenant": DEMO_TENANT },
    data: {
      locationId: DEMO_LOCATION,
      type: "missing_person",
      occurredAt: noticed.toISOString(),
      description: `Not in their room at the evening check (${RUN}).`,
      people: [{ kind: "service_user", role: "affected", personId: person }],
    },
  });
  expect(recorded.status(), await recorded.text()).toBe(201);
  const incident = (await recorded.json()) as { id: string };

  await page.goto(`/missing/new?incident=${incident.id}&person=${person}`);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await fillWhen(page, "When they were noticed missing", noticed);
  await page
    .getByRole("group", { name: /call the police at once/i })
    .getByRole("radio", { name: "No", exact: true })
    .check();
  await accessibleInBothThemes(page, "open a missing person episode");
  await page.getByRole("button", { name: "Open the episode" }).click();

  await page.waitForURL(/\/missing\/[0-9a-f-]{36}$/);
  // The police call and its target come first, in words.
  await expect(page.getByText(/call by \d{2}\/\d{2}\/\d{4}/i).first()).toBeVisible();
  await accessibleInBothThemes(page, "missing person episode");

  await page.getByLabel("What happened").selectOption("police_called");
  await fillWhen(page, "When it happened", new Date());
  await page.getByLabel("Reference").fill(`CAD ${RUN}`);
  await page.getByRole("button", { name: "Add to the timeline" }).click();
  await expect(page.getByText(`Reference: CAD ${RUN}`).first()).toBeVisible();
  await expect(page.getByText(/Police called/).first()).toBeVisible();

  await page.goto("/missing");
  await expect(page.getByRole("heading", { level: 1, name: "Missing persons" })).toBeVisible();
  await accessibleInBothThemes(page, "missing persons list");

  await page.goto(`/people/${person}/herbert`);
  await expect(
    page.getByRole("heading", { name: "Herbert Protocol profile" }).first(),
  ).toBeVisible();
  await accessibleInBothThemes(page, "Herbert Protocol profile tab");
});
