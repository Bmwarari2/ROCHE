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
 * record incidents through the API as the demo nurse and carer and read them on the screens. Each
 * run adds its own incidents, marked with the run in their narrative, and changes nothing already
 * there; nobody records an incident at Harbour Mews, so its list stays empty.
 */

const API_URL = process.env.API_URL ?? "http://localhost:4000";
const DEMO_TENANT = "0194d000-0000-7000-8000-000000000001";
const DEMO_LOCATION = "0194d000-0000-7000-8000-000000000101";
const MEWS_LOCATION = "0194d000-0000-7000-8000-000000000150";
const RUN = `run ${Date.now().toString(36)}`;
const T0 = Date.now();
const at = (offsetMinutes: number) => new Date(T0 + offsetMinutes * 60_000).toISOString();

test.describe.configure({ mode: "serial" });

// Sign in once each (Better Auth throttles sign-ins) and reuse the sessions.
const sessions: Record<string, Awaited<ReturnType<BrowserContext["cookies"]>>> = {};

test.beforeAll(async ({ browser }, testInfo) => {
  for (const user of ["nurse", "carer", "owner"]) {
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

interface Incident {
  readonly id: string;
  readonly version: number;
  readonly classifier: { readonly openQuestions: readonly { key: string; kind: string }[] } | null;
}

async function call<T = Incident>(
  request: APIRequestContext,
  path: string,
  data?: object,
  status = data ? 201 : 200,
): Promise<T> {
  const options = { headers: { "x-harbour-tenant": DEMO_TENANT }, ...(data ? { data } : {}) };
  const response = await (data ? request.post : request.get).call(
    request,
    `${API_URL}${path}`,
    options,
  );
  expect(response.status(), `${path} ${await response.text()}`).toBe(status);
  return (await response.json()) as T;
}

const recordIncident = (request: APIRequestContext, data: object) =>
  call(request, "/v1/incidents", { locationId: DEMO_LOCATION, occurredAt: at(-60), ...data });

/** Answers every open question "no" (or none, or 0), as a manager would before closing. */
async function answerEverything(request: APIRequestContext, id: string) {
  for (let round = 0; round < 6; round += 1) {
    const open = (await call(request, `/v1/incidents/${id}`)).classifier?.openQuestions ?? [];
    if (open.length === 0) return;
    const value = (kind: string) =>
      kind === "yes_no_unsure"
        ? "no"
        : kind === "days" || kind === "hours"
          ? 0
          : kind === "choice"
            ? "none"
            : ["none"];
    const answers = open.map((q) => ({ key: q.key, value: value(q.kind) }));
    await call(request, `/v1/incidents/${id}/classifier`, { answers }, 200);
  }
  throw new Error("The questions kept coming");
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
const cardFor = (page: Page, id: string) =>
  page.getByRole("article").filter({ has: page.locator(`a[href="/incidents/${id}"]`) });

test("hazard HZ-013 the nurse finds an incident in the list, with its open questions, and reads it", async ({
  page,
  context,
}) => {
  // A closed incident: raised by the carer, answered and closed by the nurse.
  await as(context, "carer");
  const toClose = await recordIncident(page.request, {
    type: "environmental",
    description: `The lift stopped between floors (${RUN}).`,
  });
  await as(context, "nurse");
  await answerEverything(page.request, toClose.id);
  const answered = await call(page.request, `/v1/incidents/${toClose.id}`);
  await call(
    page.request,
    `/v1/incidents/${toClose.id}/close`,
    { reason: "The lift was repaired and checked.", version: answered.version },
    200,
  );
  // One under review, and a behaviour incident: "not sure" whether the police are involved.
  const near = await recordIncident(page.request, {
    type: "near_miss",
    description: `A hoist sling nearly gave way (${RUN}).`,
  });
  await call(
    page.request,
    `/v1/incidents/${near.id}/review`,
    { to: "under_review", version: near.version },
    200,
  );
  const incident = await recordIncident(page.request, {
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
  const card = cardFor(page, incident.id);
  await expect(link).toHaveText(/^Behaviour, \d{2}\/\d{2}\/\d{4} \d{2}:\d{2}/);
  await expect(card.getByText("Open", { exact: true })).toBeVisible();
  await expect(
    card.getByText(/^\d+ questions? about statutory notifications to answer$/),
  ).toBeVisible();
  await expect(cardFor(page, near.id).getByText("Under review", { exact: true })).toBeVisible();
  await expect(cardFor(page, toClose.id).getByText("Closed", { exact: true })).toBeVisible();
  await expect(cardFor(page, toClose.id).getByText(/questions? about/)).toHaveCount(0);
  await expectAccessible(page, "incidents list");

  // Open it with the keyboard.
  await tabTo(page, link);
  await page.keyboard.press("Enter");
  await page.waitForURL((url) => url.pathname === `/incidents/${incident.id}`);
  await expect(page.getByRole("heading", { level: 1, name: /^Behaviour, / })).toBeVisible();
  await expect(page).toHaveTitle(/^Incident, \d{2}\/\d{2}\/\d{4} \d{2}:\d{2}/);
  await expect(page.getByRole("navigation", { name: "Breadcrumb" }).getByRole("link")).toHaveText(
    "Incidents",
  );
  // HZ-013: the questions still open are said, and that this page does not show them yet.
  await expect(
    page.getByText(/^\d+ questions? about statutory notifications to answer$/),
  ).toBeVisible();
  await expect(
    page.getByText("This page does not show the questions or statutory notifications yet"),
  ).toBeVisible();
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
  const cara = people.getByRole("listitem").filter({ hasText: "Cara Placeholder: affected" });
  await expect(cara.getByText("Communication needs", { exact: true })).toBeVisible();
  await expect(cara.getByText("Uses a hearing loop")).toBeVisible();
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
  const incident = await recordIncident(page.request, {
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
  await expect(cardFor(page, incident.id).getByText("Partly hidden from you")).toBeVisible();
  await link.click();
  await page.waitForURL((url) => url.pathname === `/incidents/${incident.id}`);
  await expect(
    page.getByText("Part of this incident is about people you cannot see"),
  ).toBeVisible();
  await expect(section(page, "About this incident")).toBeVisible();
  await expect(section(page, "What happened")).toHaveCount(0);
  const people = section(page, "People on this incident").getByRole("listitem");
  await expect(people).toHaveCount(1);
  await expect(people.first()).toContainText("Cara Placeholder: affected");
  await expect(page.getByText(`(${RUN})`, { exact: false })).toHaveCount(0);
  await expect(section(page, "Who was told")).toHaveCount(0);
  await expect(page.getByText(/questions? about statutory notifications/)).toHaveCount(0);
  await expectAccessible(page, "incident partly hidden");
});

test("the list says when there are no incidents you can see", async ({ page, context }) => {
  await as(context, "owner");
  await context.addCookies([
    { name: "harbour_location", value: MEWS_LOCATION, url: test.info().project.use.baseURL ?? "" },
  ]);
  await page.goto("/incidents");
  await expect(
    page.getByRole("heading", { level: 2, name: "No incidents you can see" }),
  ).toBeVisible();
  await expectAccessible(page, "incidents list, empty");
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
