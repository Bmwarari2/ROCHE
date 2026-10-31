import { type APIRequestContext, expect, type Page, test } from "@playwright/test";
import { expectAccessible, signIn } from "./support";

/**
 * Approvals across modules (PLAT-011; separation of duties, safety.md rule 11; HZ-013, HZ-091)
 * against the demo tenant. The Registered Manager raises two incidents and sees them waiting for
 * someone else, with no way to close them. The owner, who also manages incidents, sees them
 * waiting for their approval: one is closed here with a reason (refused in words without one), the
 * other is sent back to open. Every state passes axe in the light and dark themes. Each run adds
 * its own incidents, marked with the run, and changes nothing already there.
 */

const RUN = `run ${Date.now().toString(36)}`;
const API_URL = process.env.API_URL ?? "http://localhost:4000";
const DEMO_TENANT = "0194d000-0000-7000-8000-000000000001";
const DEMO_LOCATION = "0194d000-0000-7000-8000-000000000101";

interface Incident {
  readonly id: string;
  readonly version: number;
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

/** Answers every open classifier question "nothing to report", so closing is not held back. */
async function answerEverything(request: APIRequestContext, id: string) {
  for (let round = 0; round < 6; round += 1) {
    const state = await call<{ result: { openQuestions: { key: string; kind: string }[] } | null }>(
      request,
      `/v1/incidents/${id}/classifier`,
    );
    const open = state.result?.openQuestions ?? [];
    if (open.length === 0) return;
    const value = (kind: string) =>
      kind === "yes_no_unsure"
        ? "no"
        : kind === "days" || kind === "hours"
          ? 0
          : kind === "choice"
            ? "none"
            : ["none"];
    await call(
      request,
      `/v1/incidents/${id}/classifier`,
      { answers: open.map((q) => ({ key: q.key, value: value(q.kind) })) },
      200,
    );
  }
  throw new Error("The questions kept coming");
}

const group = (page: Page, name: string) => page.getByRole("region", { name, exact: true });
const entry = (page: Page, incidentId: string) =>
  page.locator("li", { has: page.locator(`a[href="/incidents/${incidentId}"]`) });

async function bothThemes(page: Page, name: string) {
  await expectAccessible(page, name);
  await page.emulateMedia({ colorScheme: "dark" });
  await expectAccessible(page, `${name}, dark theme`);
  await page.emulateMedia({ colorScheme: "light" });
}

test.describe.configure({ mode: "serial" });

let toClose: Incident;
let toSendBack: Incident;

test("the manager who raised an incident sees it waiting for someone else", async ({ page }) => {
  test.setTimeout(120_000);
  await signIn(page, "manager@example.invalid");
  const raise = (description: string) =>
    call(page.request, "/v1/incidents", {
      locationId: DEMO_LOCATION,
      type: "environmental",
      occurredAt: new Date(Date.now() - 15 * 60_000).toISOString(),
      description,
      people: [],
    });
  toClose = await raise(`A lounge window catch came loose (${RUN}).`);
  toSendBack = await raise(`A corridor door closer was slow (${RUN}).`);
  await answerEverything(page.request, toClose.id);
  await answerEverything(page.request, toSendBack.id);
  // The second goes under review, so it can be sent back to open.
  const current = await call(page.request, `/v1/incidents/${toSendBack.id}`);
  await call(
    page.request,
    `/v1/incidents/${toSendBack.id}/review`,
    { to: "under_review", version: current.version },
    200,
  );

  await page
    .getByRole("navigation", { name: "Modules" })
    .getByRole("link", { name: "Approvals" })
    .click();
  await page.waitForURL((url) => url.pathname === "/approvals");
  await expect(page.getByRole("heading", { level: 1, name: "Approvals" })).toBeVisible();
  const raised = group(page, "Raised by you, waiting for someone else");
  const mine = entry(page, toClose.id);
  await expect(raised.locator(`a[href="/incidents/${toClose.id}"]`)).toBeVisible();
  await expect(mine.getByText("You raised this, so someone else must approve it.")).toBeVisible();
  await expect(mine.getByText("Raised by Mo Manager")).toBeVisible();
  await expect(mine.getByText("Open", { exact: true })).toBeVisible();
  await expect(mine.getByText("No deadline")).toBeVisible();
  await expect(mine.getByRole("button", { name: "Close the incident" })).toHaveCount(0);
  await expect(
    group(page, "Waiting for your approval").locator(`a[href="/incidents/${toClose.id}"]`),
  ).toHaveCount(0);
  await bothThemes(page, "approvals, raised by you");
});

test("hazard HZ-013 hazard HZ-091 another manager closes one here and sends the other back", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await signIn(page, "owner@example.invalid");
  await page.goto("/approvals");
  const yours = group(page, "Waiting for your approval");
  const closing = entry(page, toClose.id);
  await expect(yours.locator(`a[href="/incidents/${toClose.id}"]`)).toBeVisible();
  await expect(closing.getByText("Raised by Mo Manager")).toBeVisible();
  await bothThemes(page, "approvals, waiting for you");

  // Refused in words without a reason.
  const close = closing.getByRole("form", { name: "Close the incident" });
  await close.getByRole("button", { name: "Close the incident" }).click();
  await expect(close.getByText(/Say why the incident can close/).first()).toBeVisible();
  await bothThemes(page, "approvals, close refused without a reason");

  await close.getByLabel("Why can it close?").fill(`The catch was replaced (${RUN}).`);
  await close.getByRole("button", { name: "Close the incident" }).click();
  await expect(page.getByRole("status").getByText("Incident closed")).toBeVisible();
  await expect(page.locator(`a[href="/incidents/${toClose.id}"]`)).toHaveCount(0);
  await bothThemes(page, "approvals, incident closed");

  // The one under review goes back to open with a reason, and stays waiting for approval.
  const back = entry(page, toSendBack.id).getByRole("form", { name: "Send it back to open" });
  await back
    .getByLabel("Why is it going back to open?")
    .fill(`Waiting for the contractor (${RUN}).`);
  await back.getByRole("button", { name: "Send it back to open" }).click();
  await expect(page.getByRole("status").getByText("The incident is open again")).toBeVisible();
  const reopened = entry(page, toSendBack.id);
  await expect(reopened.getByText("Open", { exact: true })).toBeVisible();
  await expect(reopened.getByRole("form", { name: "Send it back to open" })).toHaveCount(0);
  await bothThemes(page, "approvals, sent back to open");
});

test("someone with no step in any listed workflow is not offered approvals", async ({ page }) => {
  await signIn(page, "carer@example.invalid");
  await expect(
    page.getByRole("navigation", { name: "Modules" }).getByRole("link", { name: "Approvals" }),
  ).toHaveCount(0);
  await page.goto("/approvals");
  await expect(page.getByRole("heading", { level: 1, name: "Approvals" })).toBeVisible();
  await expect(page.getByText("You do not have access to this", { exact: false })).toBeVisible();
  await expectAccessible(page, "approvals, no access");
});
