import { type APIRequestContext, expect, type Page, test } from "@playwright/test";
import { expectAccessible, signIn } from "./support";

/**
 * Phase 1: an incident's investigation (register row SAFE-010; safety.md section 5; hazard
 * HZ-091) against the demo tenant. The Registered Manager is told completing it needs the
 * findings and the lessons, records the lead, method, findings and factors with an action owned by
 * the nurse (which becomes the nurse's task), then marks the action done, records the lessons,
 * marks them published as a bulletin and completes it. A stale page is refused in words. Each run
 * adds its own incidents, marked with the run, and changes nothing already there. Axe in both
 * themes.
 */

const RUN = `run ${Date.now().toString(36)}`;
const API_URL = process.env.API_URL ?? "http://localhost:4000";
const DEMO_TENANT = "0194d000-0000-7000-8000-000000000001";
const DEMO_LOCATION = "0194d000-0000-7000-8000-000000000101";

async function call<T>(
  request: APIRequestContext,
  method: "get" | "post" | "put",
  path: string,
  data?: object,
): Promise<T> {
  const response = await request[method](`${API_URL}${path}`, {
    headers: { "x-harbour-tenant": DEMO_TENANT },
    ...(data ? { data } : {}),
  });
  expect(response.ok(), `${path} ${await response.text()}`).toBe(true);
  return (await response.json()) as T;
}

/** A near miss with nobody we support on it: any manager at the location sees it whole. */
async function nearMiss(page: Page, description: string): Promise<string> {
  const incident = await call<{ id: string }>(page.request, "post", "/v1/incidents", {
    locationId: DEMO_LOCATION,
    occurredAt: new Date(Date.now() - 3 * 3_600_000).toISOString(),
    type: "near_miss",
    description: `${description} (${RUN}).`,
    emergencyServicesCalled: false,
    gpContacted: false,
  });
  return incident.id;
}

const region = (page: Page, name: string) => page.getByRole("region", { name, exact: true });
const arrived = (page: Page, words: string) =>
  expect(page.getByRole("status").getByText(words, { exact: true })).toBeVisible();

/** A date a week ahead in UK time, for the date boxes. */
function aWeekAhead(): { day: string; month: string; year: string; shown: string } {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).formatToParts(new Date(Date.now() + 7 * 86_400_000));
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return {
    day: part("day"),
    month: part("month"),
    year: part("year"),
    shown: `${part("day")}/${part("month")}/${part("year")}`,
  };
}

test.describe.configure({ mode: "serial" });

test("hazard HZ-091 the manager records an investigation, an action as the nurse's task, the lessons and a bulletin", async ({
  page,
}) => {
  test.setTimeout(150_000);
  await signIn(page, "manager@example.invalid");
  const id = await nearMiss(page, "A hoist sling was found frayed before a transfer");
  await page.goto(`/incidents/${id}`);
  const investigation = region(page, "Investigation");
  await expect(
    investigation.getByText("No investigation recorded yet. Record it below."),
  ).toBeVisible();
  const form = investigation.getByRole("form", { name: "Record the investigation" });
  await expectAccessible(page, "investigation, none yet");

  // Completing it needs the findings and the lessons, as the API checks.
  await form.getByRole("button", { name: "Save and complete it" }).click();
  const summary = page.getByRole("main").getByRole("alert");
  await expect(summary).toBeFocused();
  for (const words of [
    "Record the findings before completing it",
    "Record the lessons before completing it",
  ]) {
    await expect(summary.getByRole("link", { name: words })).toBeVisible();
  }
  await expectAccessible(page, "investigation, with errors");

  const due = aWeekAhead();
  await form.getByLabel("Who leads it?").selectOption({ label: "You" });
  await form.getByLabel("Method").selectOption({ label: "Five whys" });
  await form.getByLabel("Findings").fill(`The sling was past its inspection date (${RUN}).`);
  await form.getByLabel("Contributing factors").fill("Equipment\nNo inspection log on the unit");
  await form.getByLabel("What needs doing?").fill(`Inspect every sling on the unit (${RUN}).`);
  await form.getByLabel("Who will do it?").selectOption({ label: "Nell Nurse" });
  const dueOn = form.getByRole("group", { name: "When is it due?" });
  await dueOn.getByLabel("Day").fill(due.day);
  await dueOn.getByLabel("Month").fill(due.month);
  await dueOn.getByLabel("Year").fill(due.year);
  await form.getByRole("button", { name: "Save the investigation" }).click();
  await arrived(page, "Investigation saved");
  await expect(page.getByRole("heading", { level: 1 })).toBeFocused();

  // The action, its owner and date in words, its status as an icon and a word, and its task.
  await expect(investigation.getByText("In progress", { exact: true })).toBeVisible();
  const action = investigation
    .getByRole("listitem")
    .filter({ hasText: `Inspect every sling on the unit (${RUN}).` });
  await expect(action.getByText("Open", { exact: true })).toBeVisible();
  await expect(action.getByText(`Owner: Nell Nurse. Due ${due.shown}`)).toBeVisible();
  await expect(action.getByText("A task was made for its owner")).toBeVisible();
  await expectAccessible(page, "investigation, an action open");

  const again = region(page, "Investigation").getByRole("form", {
    name: "Record the investigation",
  });
  await again
    .getByLabel(`Status of the action: Inspect every sling on the unit (${RUN}).`)
    .selectOption({ label: "Done" });
  await again.getByLabel("Lessons learned").fill(`Check slings at every handover (${RUN}).`);
  await again.getByLabel("Mark the lessons as published in a lessons-learned bulletin").check();
  await again.getByRole("button", { name: "Save and complete it" }).click();
  await arrived(page, "Investigation completed");
  const done = region(page, "Investigation");
  await expect(done.getByText("Completed", { exact: true }).first()).toBeVisible();
  await expect(done.getByText(/^Marked as published \d{2}\/\d{2}\/\d{4}/)).toBeVisible();
  await expect(
    done
      .getByRole("listitem")
      .filter({ hasText: `Inspect every sling on the unit (${RUN}).` })
      .getByText("Done", { exact: true }),
  ).toBeVisible();
  // Once published, the bulletin is not offered again.
  await expect(
    done.getByLabel("Mark the lessons as published in a lessons-learned bulletin"),
  ).toHaveCount(0);
  await expect(done.getByRole("button", { name: "Save and reopen it" })).toBeVisible();
  await expectAccessible(page, "investigation, completed");
  await page.emulateMedia({ colorScheme: "dark" });
  await expectAccessible(page, "investigation, completed, dark theme");
  await page.emulateMedia({ colorScheme: "light" });
});

test("hazard HZ-091 a stale investigation page is refused in words", async ({ page }) => {
  await signIn(page, "manager@example.invalid");
  const id = await nearMiss(page, "A fire door was found wedged open");
  await call(page.request, "put", `/v1/incidents/${id}/investigation`, {
    findings: `The wedge was left by a visitor (${RUN}).`,
    version: 0,
  });
  await page.goto(`/incidents/${id}`);
  const form = region(page, "Investigation").getByRole("form", {
    name: "Record the investigation",
  });
  await expect(form).toBeVisible();

  // Meanwhile, elsewhere, the investigation changes: this page's copy is out of date.
  const now = await call<{ record: { version: number } }>(
    page.request,
    "get",
    `/v1/incidents/${id}/investigation`,
  );
  await call(page.request, "put", `/v1/incidents/${id}/investigation`, {
    method: "after_action_review",
    version: now.record.version,
  });
  await form.getByLabel("Lessons learned").fill(`Keep fire doors clear (${RUN}).`);
  await form.getByRole("button", { name: "Save the investigation" }).click();
  const alert = page.getByRole("main").getByRole("alert");
  await expect(alert).toBeFocused();
  await expect(alert).toContainText("This changed since the page opened");
  await expectAccessible(page, "investigation, refused");
  await page.emulateMedia({ colorScheme: "dark" });
  await expectAccessible(page, "investigation, refused, dark theme");
  await page.emulateMedia({ colorScheme: "light" });
});

test("hazard HZ-013 the incident trends are counts by type and month, said as counts only", async ({
  page,
}) => {
  await signIn(page, "manager@example.invalid");
  await nearMiss(page, "A wet floor sign was missing in the corridor");
  await page.goto("/incidents");
  await page.getByRole("link", { name: "Incident trends" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Incident trends" })).toBeVisible();
  await expect(page.getByText("Counts only, as recorded")).toBeVisible();
  const table = page.getByRole("table", { name: /^Incidents by type and month, / });
  await expect(table).toBeVisible();
  // This run's near miss is counted, with a row of totals.
  await expect(table.getByRole("rowheader", { name: "Near miss", exact: true })).toBeVisible();
  await expect(table.getByRole("rowheader", { name: "Total", exact: true })).toBeVisible();
  await expectAccessible(page, "incident trends");
  await page.emulateMedia({ colorScheme: "dark" });
  await expectAccessible(page, "incident trends, dark theme");
  await page.emulateMedia({ colorScheme: "light" });
});
