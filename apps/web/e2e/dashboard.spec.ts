import { type BrowserContext, expect, type Locator, type Page, test } from "@playwright/test";
import { expectAccessible, signIn } from "./support";

/**
 * The role dashboards on the home page (register row INSI-001; docs/specs/insights.md) against
 * the demo tenant. Each demo role sees the tiles its permissions open, each with a count in words,
 * its state as an icon and a word, and a link to its list. The run records one incident, marked
 * with the run in its narrative, and checks it is counted; it never depends on global counts.
 */

const API_URL = process.env.API_URL ?? "http://localhost:4000";
const DEMO_TENANT = "0194d000-0000-7000-8000-000000000001";
const DEMO_LOCATION = "0194d000-0000-7000-8000-000000000101";
const RUN = `run ${Date.now().toString(36)}`;

test.describe.configure({ mode: "serial" });

// Sign in once each (Better Auth throttles sign-ins) and reuse the sessions.
const sessions: Record<string, Awaited<ReturnType<BrowserContext["cookies"]>>> = {};

test.beforeAll(async ({ browser }, testInfo) => {
  for (const user of ["manager", "nurse", "carer", "owner"]) {
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

const ALL_TILES = [
  "Alerts",
  "Tasks on the round",
  "Handover",
  "DoLS authorisations ending",
  "Reviews due",
  "Incidents open",
  "Statutory notifications",
  "Outages",
  "Break-glass reports",
];

const tile = (page: Page, title: string): Locator =>
  page.getByRole("article").filter({ has: page.getByRole("heading", { level: 3, name: title }) });

/** The tiles shown, and none other; each says its state in a word with an icon and has a link. */
async function expectTiles(page: Page, shown: readonly string[]) {
  for (const title of ALL_TILES) {
    await expect(tile(page, title)).toHaveCount(shown.includes(title) ? 1 : 0);
  }
  for (const title of shown) {
    const card = tile(page, title);
    await expect(
      card.getByText(/^(Nothing waiting|To do|Overdue|Urgent|Could not load|Choose a location)$/),
    ).toBeVisible();
    await expect(card.locator("svg").first()).toBeVisible();
    await expect(card.getByRole("link")).toHaveCount(1);
  }
}

async function expectAccessibleBothThemes(page: Page, name: string) {
  await page.emulateMedia({ colorScheme: "light" });
  await expectAccessible(page, name);
  await page.emulateMedia({ colorScheme: "dark" });
  await expectAccessible(page, `${name}, dark theme`);
  await page.emulateMedia({ colorScheme: "light" });
}

test("the Registered Manager sees every tile, and an incident recorded now is counted", async ({
  page,
  context,
}) => {
  await as(context, "nurse");
  const recorded = await page.request.post(`${API_URL}/v1/incidents`, {
    headers: { "x-harbour-tenant": DEMO_TENANT },
    data: {
      locationId: DEMO_LOCATION,
      occurredAt: new Date(Date.now() - 30 * 60_000).toISOString(),
      type: "environmental",
      description: `A radiator valve leaked in the hallway (${RUN}).`,
    },
  });
  expect(recorded.status(), await recorded.text()).toBe(201);
  const { id } = (await recorded.json()) as { id: string };

  await as(context, "manager");
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "Welcome, Mo Manager" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: "Today" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: "Safety and oversight" })).toBeVisible();
  await expectTiles(page, ALL_TILES);

  // The incident just recorded is open, so the tile counts at least one and says "To do".
  const incidents = tile(page, "Incidents open");
  await expect(incidents.getByText(/^(At least )?\d+ incidents? open$/)).toBeVisible();
  await expect(incidents.getByText("To do", { exact: true })).toBeVisible();
  await expectAccessibleBothThemes(page, "manager dashboard");

  // Each count opens the list it comes from.
  await incidents.getByRole("link", { name: "View incidents" }).click();
  await page.waitForURL((url) => url.pathname === "/incidents");
  await expect(page.locator(`a[href="/incidents/${id}"]`).first()).toBeVisible();

  await page.goto("/");
  await tile(page, "Reviews due").getByRole("link", { name: "View reviews due" }).click();
  await page.waitForURL((url) => url.pathname === "/people/reviews");
  await page.goto("/");
  await tile(page, "Tasks on the round").getByRole("link", { name: "View the round" }).click();
  await page.waitForURL((url) => url.pathname.startsWith("/round"));
  await page.goto("/");
  await tile(page, "Break-glass reports").getByRole("link").click();
  await page.waitForURL((url) => url.pathname === "/break-glass/weekly-report");
});

test("the nurse sees the clinical and safety tiles, not the break-glass reports", async ({
  page,
  context,
}) => {
  await as(context, "nurse");
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "Welcome, Nell Nurse" })).toBeVisible();
  await expect(tile(page, "Break-glass reports")).toHaveCount(0);
  await expect(tile(page, "Alerts")).toHaveCount(1);
  await expect(tile(page, "Tasks on the round")).toHaveCount(1);
  await expect(tile(page, "Incidents open")).toHaveCount(1);
  await expectAccessibleBothThemes(page, "nurse dashboard");
});

test("the carer sees their own work, without the manager's oversight tiles", async ({
  page,
  context,
}) => {
  await as(context, "carer");
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "Welcome, Cat Carer" })).toBeVisible();
  for (const title of ["Alerts", "Tasks on the round", "Reviews due"]) {
    await expect(tile(page, title)).toHaveCount(1);
  }
  for (const title of [
    "DoLS authorisations ending",
    "Statutory notifications",
    "Outages",
    "Break-glass reports",
  ]) {
    await expect(tile(page, title)).toHaveCount(0);
  }
  await expect(
    tile(page, "Alerts").getByRole("link", { name: "View your notifications" }),
  ).toBeVisible();
  await expectAccessibleBothThemes(page, "carer dashboard");

  // On a phone the tiles stack and the page does not scroll sideways.
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto("/");
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});

test("the owner sees every tile", async ({ page, context }) => {
  await as(context, "owner");
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "Welcome, Olive Owner" })).toBeVisible();
  await expectTiles(page, ALL_TILES);
  await expectAccessibleBothThemes(page, "owner dashboard");
});
