import {
  type APIRequestContext,
  type BrowserContext,
  expect,
  type Locator,
  type Page,
  test,
} from "@playwright/test";
import { demoPerson, expectAccessible, settleAnimations, signIn } from "./support";

/**
 * Phase 1 slice 9: the incident screens, read only (register rows SAFE-001 and SAFE-002; hazard
 * HZ-013) against the demo tenant. Recording and managing incidents come later, so the journeys
 * record incidents through the API as the demo nurse and read them on the screens. Each run adds
 * its own incidents, marked with the run in their narrative, and changes nothing already there.
 */

const API_URL = process.env.API_URL ?? "http://localhost:4000";
const DEMO_TENANT = "0194d000-0000-7000-8000-000000000001";
const DEMO_LOCATION = "0194d000-0000-7000-8000-000000000101";
const RUN = `run ${Date.now().toString(36)}`;
const T0 = Date.now();
const at = (offsetMinutes: number) => new Date(T0 + offsetMinutes * 60_000).toISOString();

test.describe.configure({ mode: "serial" });

// Sign in once each (Better Auth throttles sign-ins) and reuse the sessions.
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

async function post(request: APIRequestContext, path: string, data: object) {
  const response = await request.post(`${API_URL}${path}`, {
    headers: { "x-harbour-tenant": DEMO_TENANT },
    data,
  });
  expect(response.status(), `${path} ${await response.text()}`).toBe(201);
  return (await response.json()) as { id: string };
}

/** Presses Tab until the target has focus: the keyboard is the only way in. */
async function tabTo(page: Page, target: Locator, limit = 300) {
  for (let presses = 0; presses < limit; presses += 1) {
    if (await target.evaluate((element) => element === document.activeElement)) return;
    await page.keyboard.press("Tab");
  }
  throw new Error("The target could not be reached with the Tab key");
}

const section = (page: Page, name: string) => page.getByRole("region", { name });

test("hazard HZ-013 the nurse finds an incident in the list, with its open questions, and reads it", async ({
  page,
  context,
}) => {
  await as(context, "nurse");
  // A behaviour incident: "not sure" whether the police are involved, other questions open.
  const incident = await post(page.request, "/v1/incidents", {
    locationId: DEMO_LOCATION,
    type: "behaviour",
    occurredAt: at(-45),
    description: `Shouting in the lounge, then pushed a chair over (${RUN}).`,
    immediateActions: "Moved other residents to the dining room and stayed with her.",
    gpContacted: true,
    familyInformed: { who: "Her daughter", at: at(-20) },
    people: [
      { kind: "service_user", role: "affected", personId: demoPerson(3) },
      { kind: "other_not_at_work", role: "witness", otherName: "Vic Visitor" },
    ],
    answers: [{ key: "police.involved", value: "unsure" }],
  });

  await page.goto("/");
  const modules = page.getByRole("navigation", { name: "Modules" });
  await modules.getByRole("link", { name: "Incidents" }).click();
  await page.waitForURL((url) => url.pathname === "/incidents");
  await expect(page.getByRole("heading", { level: 1, name: "Incidents" })).toBeVisible();
  await expect(modules.getByRole("link", { name: "Incidents" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  const link = page.locator(`a[href="/incidents/${incident.id}"]`);
  const card = page.getByRole("article").filter({ has: link });
  await expect(link).toHaveText(/^Behaviour, \d{2}\/\d{2}\/\d{4} \d{2}:\d{2}/);
  await expect(card.getByText("Open", { exact: true })).toBeVisible();
  await expect(card.getByText(/^\d+ questions? to answer$/)).toBeVisible();
  await expectAccessible(page, "incidents list");

  // Open it with the keyboard.
  await tabTo(page, link);
  await page.keyboard.press("Enter");
  await page.waitForURL((url) => url.pathname === `/incidents/${incident.id}`);
  await expect(page.getByRole("heading", { level: 1, name: /^Behaviour, / })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Breadcrumb" }).getByRole("link")).toHaveText(
    "Incidents",
  );
  const details = section(page, "What happened");
  await expect(details.getByText(`(${RUN})`, { exact: false })).toBeVisible();
  await expect(details.getByText("Moved other residents to the dining room")).toBeVisible();
  await expect(details.getByText("You", { exact: true })).toBeVisible();
  const told = section(page, "Who was told");
  await expect(told.getByText(/^Her daughter, told \d{2}\/\d{2}\/\d{4} \d{2}:\d{2}/)).toBeVisible();
  await expect(told.locator("div").filter({ hasText: /^GP contactedYes$/ })).toBeVisible();
  await expect(
    told.locator("div").filter({ hasText: /^Emergency services calledNo$/ }),
  ).toBeVisible();
  const people = section(page, "People on this incident");
  await expect(people.getByText("Cara Placeholder: affected")).toBeVisible();
  await expect(people.getByText("Vic Visitor: witness")).toBeVisible();

  await expectAccessible(page, "incident");
  await page.emulateMedia({ colorScheme: "dark" });
  await expectAccessible(page, "incident, dark theme");
  await page.goto("/incidents");
  await expectAccessible(page, "incidents list, dark theme");
  await page.emulateMedia({ colorScheme: "light" });
});

test("hazard HZ-013 a carer who cannot see everyone on an incident sees it partly hidden", async ({
  page,
  context,
}) => {
  await as(context, "nurse");
  // The demo carer supports residents 1 to 3; Else (resident 5) is outside her scope.
  const incident = await post(page.request, "/v1/incidents", {
    locationId: DEMO_LOCATION,
    type: "fall",
    occurredAt: at(-30),
    description: `Both slipped on a wet floor in the corridor (${RUN}).`,
    people: [
      { kind: "service_user", role: "affected", personId: demoPerson(3) },
      { kind: "service_user", role: "affected", personId: demoPerson(5) },
    ],
  });

  await as(context, "carer");
  await page.goto("/incidents");
  const link = page.locator(`a[href="/incidents/${incident.id}"]`);
  const card = page.getByRole("article").filter({ has: link });
  await expect(card.getByText("Partly hidden from you")).toBeVisible();
  await link.click();
  await page.waitForURL((url) => url.pathname === `/incidents/${incident.id}`);
  await expect(
    page.getByText("Part of this incident is about people you cannot see"),
  ).toBeVisible();
  await expect(section(page, "People on this incident").getByRole("listitem")).toHaveText([
    "Cara Placeholder: affected",
  ]);
  await expect(page.getByText(`(${RUN})`, { exact: false })).toHaveCount(0);
  await expect(section(page, "Who was told")).toHaveCount(0);
  await expect(section(page, "Statutory notifications")).toHaveCount(0);
  await expectAccessible(page, "incident partly hidden");
});

test("the incident screens reflow at 320 px", async ({ page, context }) => {
  await as(context, "nurse");
  await page.setViewportSize({ width: 320, height: 900 });
  await page.goto("/incidents");
  // On a phone the shell's sidebar folds to its icons; measure once it has finished folding.
  await page.locator('[data-collapsed="true"]').waitFor();
  await settleAnimations(page);
  const overflow = () =>
    page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
  expect(await overflow(), "the list scrolls sideways").toBeLessThanOrEqual(0);
  await page.locator('a[href^="/incidents/"]').first().click();
  await page.waitForURL(/\/incidents\/[0-9a-f-]{36}$/);
  await page.locator('[data-collapsed="true"]').waitFor();
  await settleAnimations(page);
  expect(await overflow(), "the incident scrolls sideways").toBeLessThanOrEqual(0);
  await expectAccessible(page, "incident at 320 px");
});
