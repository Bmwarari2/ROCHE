import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import { expectAccessible, signIn } from "./support";

/**
 * Phase 2 slice 61: the lone-working screens (SCHED-012; hazard HZ-125) against the demo tenant.
 * The manager (Registered Manager: scheduling.lone_worker.manage and .monitor) names the on-call
 * route; the carer (scheduling.lone_worker.check_in) starts a session, checks in and asks for help;
 * the manager sees the help alarm at the top of the board with the carer's name and acknowledges
 * it; the carer finishes. The carer is never offered duress, the board or the route. A session
 * left open by an earlier attempt is finished first through the API. Every state is checked with
 * axe.
 */

const API_URL = process.env.API_URL ?? "http://localhost:4000";
const DEMO_TENANT = "0194d000-0000-7000-8000-000000000001";
const RUN = `run ${Date.now().toString(36)}`;

const sessions: Record<string, Awaited<ReturnType<BrowserContext["cookies"]>>> = {};

test.beforeAll(async ({ browser }, testInfo) => {
  test.setTimeout(300_000);
  for (const user of ["manager", "carer"]) {
    const context = await browser.newContext({ baseURL: testInfo.project.use.baseURL });
    await signIn(await context.newPage(), `${user}@example.invalid`);
    sessions[user] = await context.cookies();
    if (user === "carer") {
      // One open session per worker: finish one an earlier attempt left open.
      const headers = { "x-harbour-tenant": DEMO_TENANT };
      const mine = (await (
        await context.request.get(`${API_URL}/v1/lone-worker/sessions/mine`, { headers })
      ).json()) as { session: { id: string; status: string } | null };
      if (mine.session && mine.session.status !== "finished") {
        await context.request.post(`${API_URL}/v1/lone-worker/sessions/${mine.session.id}/events`, {
          headers,
          data: { id: crypto.randomUUID(), kind: "finish", deviceAt: new Date().toISOString() },
        });
      }
    }
    await context.close();
  }
});

async function as(context: BrowserContext, user: string) {
  await context.clearCookies();
  await context.addCookies(sessions[user] ?? []);
}

async function nameRoute(page: Page) {
  await page.goto("/lone-working/route");
  await expect(page.getByRole("heading", { level: 1, name: "On-call route" })).toBeVisible();
  await expectAccessible(page, "lone-working route");
  const step = (n: number) => page.getByRole("group", { name: `Step ${n}` });
  await step(1).getByLabel("Who is told").selectOption("role:owner");
  await step(2).getByLabel("Minutes after the alarm").fill("15");
  await step(2).getByLabel("Who is told").selectOption("role:registered_manager");
  for (const n of [1, 2]) {
    await step(n).getByLabel("Email").check();
  }
  await page.getByRole("button", { name: "Save route" }).click();
  await expect(page.getByText("Route saved")).toBeVisible();
  await expect(page.getByText("Switched on")).toBeVisible();
  await expectAccessible(page, "lone-working route saved");
}

test("hazard HZ-125 a manager names the route, a carer checks in and asks for help, the manager acknowledges", async ({
  context,
  page,
}) => {
  test.setTimeout(180_000);
  await as(context, "manager");
  await nameRoute(page);

  // A step that reaches people only inside Harbour is refused in words, before anything is sent.
  const step2 = page.getByRole("group", { name: "Step 2" });
  for (const channel of ["Phone notification", "Email", "Text message"]) {
    await step2.getByLabel(channel).uncheck();
  }
  await page.getByRole("button", { name: "Save route" }).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText(
    "so they are told away from Harbour",
  );
  await expectAccessible(page, "lone-working route refused");
  await nameRoute(page);

  await as(context, "carer");
  await page.goto("/lone-working");
  await expect(page.getByRole("heading", { level: 1, name: "Lone working" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Lone workers now" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "On-call route" })).toHaveCount(0);
  await expectAccessible(page, "lone-working start");
  await page.getByLabel("Where are you working?").selectOption({ label: "Harbour House" });
  await page.getByRole("radio", { name: "Night shift" }).check();
  await page.getByLabel("Hours").fill("2");
  await page.getByLabel("Check in every (minutes)").fill("30");
  await page.getByRole("button", { name: "Start session" }).click();
  await expect(page.locator("[data-arrival-notice]")).toBeFocused();
  await expect(page.locator("[data-arrival-notice]")).toContainText(
    "Session started. Check in by the time shown.",
  );
  await expect(page.getByRole("button", { name: "Check in: I am safe" })).toBeVisible();
  await expect(page.getByText(/Next check-in due by/)).toBeVisible();
  // Duress is never offered or named on the worker's screen.
  await expect(page.getByText(/duress/i)).toHaveCount(0);
  await expectAccessible(page, "lone-working session");

  await page.getByRole("button", { name: "Check in: I am safe" }).click();
  await expect(page.getByText("Thank you. You are checked in.")).toBeVisible();
  await expect(
    page
      .getByRole("list")
      .getByText(/Checked in at/)
      .first(),
  ).toBeVisible();

  await page.getByRole("button", { name: "Ask for help now" }).click();
  await expect(
    page
      .getByRole("list")
      .getByText(/Asked for help at/)
      .first(),
  ).toBeVisible();
  await expectAccessible(page, "lone-working help asked");

  await as(context, "manager");
  await page.goto("/lone-working/board");
  await expect(page.getByRole("heading", { level: 1, name: "Lone workers now" })).toBeVisible();
  const first = page.getByRole("article").first();
  await expect(first.getByRole("heading", { level: 3 })).toContainText("Help requested");
  await expect(first).toContainText("call 999");
  await expectAccessible(page, "lone-working board");
  await first.getByRole("radio", { name: "Help sent to them" }).check();
  await first.getByLabel("Note").fill(`Sent the team leader to the worker (${RUN}).`);
  await first.getByRole("button", { name: "Acknowledge alarm" }).click();
  // Said above the alarms once the alarm has closed, with the incident prompt for help sent.
  await expect(page.locator("[data-arrival-notice]")).toBeFocused();
  await expect(page.locator("[data-arrival-notice]")).toContainText(/acknowledged: help sent/);
  await expect(page.getByRole("link", { name: "Report an incident" })).toBeVisible();
  await expectAccessible(page, "lone-working acknowledged");

  await as(context, "carer");
  await page.goto("/lone-working");
  await page.getByRole("button", { name: "Finish session" }).click();
  // Finishing asks first: a finished session tells nobody if the worker goes quiet.
  await expect(page.getByRole("button", { name: "Keep session going" })).toBeFocused();
  await expectAccessible(page, "lone-working finish question");
  await page.getByRole("button", { name: "Finish session" }).click();
  await expect(page.locator("[data-arrival-notice]")).toBeFocused();
  await expect(page.locator("[data-arrival-notice]")).toContainText(/Session finished/);
  await expect(page.getByRole("button", { name: "Start session" })).toBeVisible();
});

test("hazard HZ-125 the carer cannot open the board or the route", async ({ context, page }) => {
  await as(context, "carer");
  for (const path of ["/lone-working/board", "/lone-working/route"]) {
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.getByRole("button", { name: /Acknowledge alarm|Save route/ })).toHaveCount(0);
  }
});
