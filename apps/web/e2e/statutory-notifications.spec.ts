import { type BrowserContext, expect, type Locator, type Page, test } from "@playwright/test";
import { demoPerson, expectAccessible, settleAnimations, signIn } from "./support";

/**
 * Phase 1 slice 9: the statutory notification pages, read only (register rows SAFE-002 and
 * SAFE-003; hazard HZ-013) against the demo tenant. The journeys record incidents through the API
 * as the demo nurse, which drafts the notifications, and read them on the screens. Each run adds
 * its own incidents, marked with the run in their narrative, and changes nothing already there.
 */

const API_URL = process.env.API_URL ?? "http://localhost:4000";
const DEMO_TENANT = "0194d000-0000-7000-8000-000000000001";
const DEMO_LOCATION = "0194d000-0000-7000-8000-000000000101";
const RUN = `run ${Date.now().toString(36)}`;
const T0 = Date.now();
const at = (offsetMinutes: number) => new Date(T0 + offsetMinutes * 60_000).toISOString();

test.describe.configure({ mode: "serial" });

const sessions: Record<string, Awaited<ReturnType<BrowserContext["cookies"]>>> = {};

test.beforeAll(async ({ browser }, testInfo) => {
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

interface Recorded {
  readonly id: string;
  readonly classifier: { readonly notifications: readonly { id: string; kind: string }[] } | null;
}

/** Records a behaviour incident, "not sure" whether the police are involved: a provisional draft. */
async function recordPoliceIncident(page: Page): Promise<{ incident: Recorded; id: string }> {
  const response = await page.request.post(`${API_URL}/v1/incidents`, {
    headers: { "x-harbour-tenant": DEMO_TENANT },
    data: {
      locationId: DEMO_LOCATION,
      type: "behaviour",
      occurredAt: at(-50),
      description: `Threw a cup at a visitor in the hall (${RUN}).`,
      people: [{ kind: "service_user", role: "affected", personId: demoPerson(3) }],
      answers: [{ key: "police.involved", value: "unsure" }],
    },
  });
  expect(response.status(), await response.text()).toBe(201);
  const incident = (await response.json()) as Recorded;
  const police = incident.classifier?.notifications.find((n) => n.kind === "cqc_reg18_police");
  expect(police, "a police notification draft").toBeDefined();
  return { incident, id: police?.id ?? "" };
}

/** Records a fall in which demo person 3 died: a death notification about her, overdue at once. */
async function recordDeath(page: Page): Promise<string> {
  const response = await page.request.post(`${API_URL}/v1/incidents`, {
    headers: { "x-harbour-tenant": DEMO_TENANT },
    data: {
      locationId: DEMO_LOCATION,
      type: "fall",
      occurredAt: at(-40),
      description: `Found on the floor of her room, not breathing (${RUN}).`,
      people: [{ kind: "service_user", role: "affected", personId: demoPerson(3), died: true }],
    },
  });
  expect(response.status(), await response.text()).toBe(201);
  const incident = (await response.json()) as Recorded;
  const death = incident.classifier?.notifications.find((n) => n.kind === "cqc_reg16_death");
  expect(death, "a death notification draft").toBeDefined();
  return death?.id ?? "";
}

/** Presses Tab until the target has focus: the keyboard is the only way in. */
async function tabTo(page: Page, target: Locator, limit = 400) {
  for (let presses = 0; presses < limit; presses += 1) {
    if (await target.evaluate((element) => element === document.activeElement)) return;
    await page.keyboard.press("Tab");
  }
  throw new Error("The target could not be reached with the Tab key");
}

const section = (page: Page, name: string) => page.getByRole("region", { name });

test("hazard HZ-013 the nurse finds an overdue notification and reads its deadlines, sources and record", async ({
  page,
  context,
}) => {
  await as(context, "nurse");
  const { incident, id } = await recordPoliceIncident(page);
  const death = await recordDeath(page);

  // From the incidents list, the nurse (safety.incident.manage) goes to the notifications.
  await page.goto("/incidents");
  await page.getByRole("link", { name: "Statutory notifications" }).click();
  await page.waitForURL((url) => url.pathname === "/notifications/statutory");
  await expect(
    page.getByRole("heading", { level: 1, name: "Statutory notifications" }),
  ).toBeVisible();
  // The page sits with incidents in the sidebar, never the notification centre.
  const modules = page.getByRole("navigation", { name: "Modules" });
  await expect(modules.getByRole("link", { name: "Incidents" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(modules.getByRole("link", { name: /^Notifications/ })).not.toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(
    page.getByText(/^Clocks worked out at \d{2}\/\d{2}\/\d{4} \d{2}:\d{2}\./),
  ).toBeVisible();
  const todo = section(page, "Still to do");
  await expect(section(page, "Submitted or not required")).toBeVisible();
  const link = todo.locator(`a[href="/notifications/statutory/${id}"]`);
  await expect(link).toHaveText("Incident reported to or investigated by the police");
  const item = todo.getByRole("listitem").filter({ has: link });
  await expect(item.getByText(/^Overdue for \d+ (minute|minutes|hour|hours)$/)).toBeVisible();
  await expect(item.getByText("Draft", { exact: true })).toBeVisible();
  await expect(item.getByText(/^Due by \d{2}\/\d{2}\/\d{4} \d{2}:\d{2}$/)).toBeVisible();
  await expect(item.getByText("To the Care Quality Commission")).toBeVisible();
  await expect(item.getByText(/^Provisional: it rests on an answer of not sure\./)).toBeVisible();
  // Who a notification is about, with her communication needs beside her name (AIS).
  const about = todo
    .getByRole("listitem")
    .filter({ has: todo.locator(`a[href="/notifications/statutory/${death}"]`) });
  await expect(about.getByText("About Cara Placeholder")).toBeVisible();
  await expect(about.getByRole("term")).toHaveText("Communication needs");
  await expect(about.getByRole("definition")).toContainText("Uses a hearing loop");
  await expectAccessible(page, "statutory notifications");

  // Open it with the keyboard.
  await tabTo(page, link);
  await page.keyboard.press("Enter");
  await page.waitForURL((url) => url.pathname === `/notifications/statutory/${id}`);
  await expect(
    page.getByRole("heading", {
      level: 1,
      name: "Incident reported to or investigated by the police",
    }),
  ).toBeVisible();
  await expect(page).toHaveTitle(/^Incident reported to or investigated by the police/);
  const breadcrumb = page.getByRole("navigation", { name: "Breadcrumb" });
  await expect(breadcrumb.getByRole("link")).toHaveText("Statutory notifications");
  await expect(breadcrumb.locator('[aria-current="page"]')).toHaveText(
    "Incident reported to or investigated by the police",
  );
  await expect(page.getByText(/^Overdue for \d+ (minute|minutes|hour|hours)$/)).toBeVisible();
  await expect(page.getByText("Draft", { exact: true })).toBeVisible();
  await expect(page.getByText(/^Provisional: it rests on an answer of not sure\./)).toBeVisible();
  // Without delay: the clock started when it happened, in a time element a machine can read.
  const started = section(page, "Deadlines").locator("time");
  await expect(started).toHaveText(
    /^Without delay: the clock started \d{2}\/\d{2}\/\d{4} \d{2}:\d{2}/,
  );
  expect(Date.parse((await started.getAttribute("datetime")) ?? "")).toBe(Date.parse(at(-50)));
  // The record it was drafted on, named and linked, with its status.
  const drafted = section(page, "Drafted on");
  await expect(drafted.getByRole("link")).toHaveText(
    /^Behaviour, \d{2}\/\d{2}\/\d{4} \d{2}:\d{2}$/,
  );
  await expect(drafted.getByText("Open", { exact: true })).toBeVisible();
  await expect(
    section(page, "How it ended").getByText("Not submitted or decided yet"),
  ).toBeVisible();
  await expectAccessible(page, "statutory notification");
  await page.emulateMedia({ colorScheme: "dark" });
  await expectAccessible(page, "statutory notification, dark theme");
  await page.goto("/notifications/statutory");
  await expectAccessible(page, "statutory notifications, dark theme");
  await page.emulateMedia({ colorScheme: "light" });

  // The death notification's page: who it is about, with her communication needs.
  await page.goto(`/notifications/statutory/${death}`);
  await expect(page.getByText("About Cara Placeholder")).toBeVisible();
  const needs = page.locator("main dl").filter({ hasText: "Communication needs" }).first();
  await expect(needs.getByRole("definition")).toContainText("Uses a hearing loop");
  await expectAccessible(page, "statutory notification about a person");

  // From the incident, the notification opens its own page.
  await page.goto(`/incidents/${incident.id}`);
  await expectAccessible(page, "incident with linked notifications");
  const onIncident = section(page, "Statutory notifications").locator(
    `a[href="/notifications/statutory/${id}"]`,
  );
  await expect(onIncident).toHaveText("Incident reported to or investigated by the police");
  await onIncident.click();
  await page.waitForURL((url) => url.pathname === `/notifications/statutory/${id}`);
  await section(page, "Drafted on").getByRole("link").click();
  await page.waitForURL((url) => url.pathname === `/incidents/${incident.id}`);
});

test("hazard HZ-013 a carer without safety.incident.manage is told the notification pages are not for them", async ({
  page,
  context,
}) => {
  await as(context, "nurse");
  const { id } = await recordPoliceIncident(page);
  await as(context, "carer");
  for (const path of ["/notifications/statutory", `/notifications/statutory/${id}`]) {
    await page.goto(path);
    await expect(
      page.getByText("You do not have access to this. Ask your manager if you need it."),
    ).toBeVisible();
    await expect(page.getByText("Incident reported to or investigated by the police")).toHaveCount(
      0,
    );
    await expectAccessible(page, `${path}, no access`);
  }
  await page.goto("/incidents");
  await expect(page.getByRole("link", { name: "Statutory notifications" })).toHaveCount(0);
});

test("hazard HZ-013 the statutory notification pages reflow at 320 px", async ({
  page,
  context,
}) => {
  await as(context, "nurse");
  const { id } = await recordPoliceIncident(page);
  await page.setViewportSize({ width: 320, height: 900 });
  const overflow = () =>
    page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
  for (const path of ["/notifications/statutory", `/notifications/statutory/${id}`]) {
    await page.goto(path);
    await page.locator('[data-collapsed="true"]').waitFor();
    await settleAnimations(page);
    expect(await overflow(), `${path} scrolls sideways`).toBeLessThanOrEqual(0);
    await expectAccessible(page, `${path} at 320 px`);
  }
});
