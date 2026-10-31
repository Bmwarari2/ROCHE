import { randomUUID } from "node:crypto";
import { type APIRequestContext, expect, type Page, test } from "@playwright/test";
import { addDemoPasskey, demoPerson, expectAccessible, signIn } from "./support";

/**
 * Tasks (PLAT-011; hazards HZ-004, HZ-006, HZ-008) against the demo tenant, as the Registered
 * Manager (platform.task.manage). The review data is made through the API as a device would: an
 * entry naming a task already done leaves the task alone and is listed on a review task for the
 * nurse in charge; an entry naming a cancelled task is kept as late evidence. The page must show
 * both (HZ-006). Then the manager creates, starts, completes and skips tasks on the page. Every
 * task is tagged with this run, so re-runs never depend on counts. Each state is checked with axe
 * in light and dark themes.
 */

const API_URL = process.env.API_URL ?? "http://localhost:4000";
const DEMO_TENANT = "0194d000-0000-7000-8000-000000000001";
const DEMO_LOCATION = "0194d000-0000-7000-8000-000000000101";
const PERSON = demoPerson(3);
const RUN = randomUUID().slice(0, 8);

test.describe.configure({ mode: "serial" });

const main = (page: Page) => page.getByRole("main");
const task = (page: Page, title: string | RegExp) =>
  main(page)
    .getByRole("listitem")
    .filter({ has: page.getByRole("heading", { name: title }) });

async function api<T>(
  request: APIRequestContext,
  method: "GET" | "POST",
  path: string,
  data?: unknown,
): Promise<T> {
  const response = await request.fetch(`${API_URL}${path}`, {
    method,
    headers: { "x-harbour-tenant": DEMO_TENANT },
    ...(data ? { data } : {}),
  });
  expect(response.ok(), `${method} ${path}: ${response.status()}`).toBe(true);
  return (await response.json()) as T;
}

interface Task {
  readonly id: string;
  readonly kind: string;
  readonly version: number;
  readonly title: string;
  readonly details: { entries?: { clientId?: string | null; entryId?: string | null }[] } | null;
}

/** The signed-in member's own id, so this run's tasks are theirs and found under My tasks. */
async function selfId(request: APIRequestContext): Promise<string> {
  return (await api<{ tenantUserId: string }>(request, "GET", "/v1/me")).tenantUserId;
}

/**
 * A task about the person, due in ten minutes, made through the API and given to the manager: a
 * home with many open tasks (CI runs every journey first) shows a page at a time, busiest first,
 * so the journey finds its own tasks under My tasks.
 */
async function personTask(request: APIRequestContext, title: string): Promise<Task> {
  return api<Task>(request, "POST", "/v1/tasks", {
    title,
    personId: PERSON,
    assigneeTenantUserId: await selfId(request),
    dueAt: new Date(Date.now() + 10 * 60_000).toISOString(),
  });
}

/** A care note naming the task, as a device sends it: the entry is kept whatever the task's state. */
async function noteFor(request: APIRequestContext, taskId: string): Promise<string> {
  const id = randomUUID();
  await api(request, "POST", `/v1/people/${PERSON}/notes`, {
    id,
    occurredAt: new Date().toISOString(),
    category: "other",
    body: `Journey note ${RUN}`,
    taskId,
  });
  return id;
}

async function bothThemes(page: Page, name: string) {
  await expectAccessible(page, `${name} (light)`);
  await page.emulateMedia({ colorScheme: "dark" });
  await expectAccessible(page, `${name} (dark)`);
  await page.emulateMedia({ colorScheme: "light" });
}

test.beforeEach(async ({ page }) => {
  await signIn(page, "manager@example.invalid");
});

test("hazards HZ-004 and HZ-006 a review task shows the entries to review, and a task its late evidence", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const request = page.request;
  // A round already done: an entry naming it is kept, not linked, and listed for review.
  const done = await personTask(request, `Journey check done ${RUN}`);
  await api(request, "POST", `/v1/tasks/${done.id}/transition`, {
    to: "done",
    version: done.version,
  });
  const reviewedEntry = await noteFor(request, done.id);
  // A round cancelled (the person went out): an entry naming it is kept as late evidence.
  const cancelled = await personTask(request, `Journey check cancelled ${RUN}`);
  await api(request, "POST", `/v1/tasks/${cancelled.id}/transition`, {
    to: "cancelled",
    version: cancelled.version,
    reason: "Out at hospital",
  });
  await noteFor(request, cancelled.id);

  // The review task that lists the entry (one review gathers a location's entries).
  const open = await api<{ items: Task[] }>(request, "GET", "/v1/tasks?view=all&status=open");
  const review = open.items.find(
    (t) =>
      t.kind === "care.entry_review" &&
      (t.details?.entries ?? []).some((e) => e.entryId === reviewedEntry),
  );
  expect(review, "a review task lists the entry").toBeDefined();
  if (!review) return;

  await page.goto("/tasks?reviews=yes");
  await expect(page.getByRole("heading", { level: 1, name: "Tasks" })).toBeVisible();
  const reviewItem = main(page).locator(`li[data-task-id="${review.id}"]`);
  await expect(reviewItem).toBeVisible();
  await expect(reviewItem.getByText("Review", { exact: true })).toBeVisible();
  await expect(reviewItem.getByRole("heading", { name: "Entries to review" })).toBeVisible();
  await expect(reviewItem).toContainText(reviewedEntry);
  await bothThemes(page, "review task with its entries");

  // The cancelled round, in the finished tasks, says its evidence arrived after it was cancelled.
  await page.goto("/tasks?view=mine&status=closed");
  const late = task(page, `Journey check cancelled ${RUN}`);
  await expect(late).toContainText("Cancelled");
  await expect(late).toContainText("Recorded after it was cancelled");
  await expect(late).toContainText("Out at hospital");
  // The round done before the entry arrived stays done, with no late-evidence flag.
  const kept = task(page, `Journey check done ${RUN}`);
  await expect(kept).toContainText("Done");
  await expect(kept).not.toContainText("Recorded after it was cancelled");
  await bothThemes(page, "finished tasks");
});

test("the manager creates a task, starts it and marks it done", async ({ page }) => {
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "Modules" })
    .getByRole("link", { name: "Tasks" })
    .click();
  await expect(page.getByRole("heading", { level: 1, name: "Tasks" })).toBeVisible();
  // Team tasks first: reviews go to a role, not a person (HZ-006).
  await expect(page.getByRole("link", { name: "Team tasks" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  // This journey's task is the manager's own: the form and the task are under My tasks, however
  // busy the home is (CI runs every journey first).
  await page.getByRole("link", { name: "My tasks" }).click();
  await expect(page.getByRole("link", { name: "My tasks" })).toHaveAttribute(
    "aria-current",
    "page",
  );

  // Nothing filled in: each field says what to do.
  const form = main(page).getByRole("region", { name: "Create a task" });
  await form.getByRole("button", { name: "Create task" }).click();
  await expect(
    form.getByText("Say what needs doing, in 3 to 120 characters.").first(),
  ).toBeVisible();
  await bothThemes(page, "new task errors");

  const title = `Check the fire doors ${RUN}`;
  const soon = new Date(Date.now() + 60 * 60_000);
  const uk = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(soon);
  const part = (type: string) => uk.find((p) => p.type === type)?.value ?? "";
  await form.getByLabel("What needs doing").fill(title);
  await form.getByRole("textbox", { name: "Day", exact: true }).fill(part("day"));
  await form.getByRole("textbox", { name: "Month", exact: true }).fill(part("month"));
  await form.getByRole("textbox", { name: "Year", exact: true }).fill(part("year"));
  await form.getByRole("textbox", { name: "Hour", exact: true }).fill(part("hour"));
  await form.getByRole("textbox", { name: "Minute", exact: true }).fill(part("minute"));
  await form.getByLabel("Urgent").check();
  await form.getByLabel("Assign it to me").check();
  await form.getByRole("button", { name: "Create task" }).click();
  await expect(main(page).getByRole("status").filter({ hasText: "Task created." })).toBeVisible();

  const created = task(page, title);
  await expect(created).toContainText("Urgent");
  await expect(created).toContainText(/Upcoming|Due/);
  await expect(created).toContainText("You");
  await expect(created).toContainText(`${part("day")}/${part("month")}/${part("year")}`);
  await bothThemes(page, "task created");

  await created.getByRole("button", { name: "Start" }).click();
  await expect(main(page).getByRole("status").filter({ hasText: "Task started." })).toBeVisible();
  await expect(task(page, title)).toContainText("Started");
  await task(page, title).getByRole("button", { name: "Mark as done" }).click();
  await expect(
    main(page).getByRole("status").filter({ hasText: "Task marked as done." }),
  ).toBeVisible();
  await expect(task(page, title)).toHaveCount(0);

  await main(page).getByRole("link", { name: "Finished" }).click();
  await expect(task(page, title)).toContainText("Done");
});

test("a task not done needs a reason, and the reason is shown", async ({ page }) => {
  const title = `Journey not done ${RUN}`;
  const made = await api<Task>(page.request, "POST", "/v1/tasks", {
    title,
    locationId: DEMO_LOCATION,
    assigneeTenantUserId: await selfId(page.request),
    dueAt: new Date(Date.now() + 30 * 60_000).toISOString(),
  });
  expect(made.id).toBeTruthy();
  // The team list, however busy, renders a page at a time and passes axe in both themes.
  await page.goto("/tasks");
  await expect(main(page).locator("li[data-task-id]").first()).toBeVisible();
  expect(await main(page).locator("li[data-task-id]").count()).toBeLessThanOrEqual(40);
  await bothThemes(page, "team tasks");

  await page.goto("/tasks?view=mine");
  const item = task(page, title);
  await item.getByRole("button", { name: "Record as not done" }).click();
  const sheet = page.getByRole("dialog", { name: `Not done: ${title}` });
  await sheet.getByRole("button", { name: "Record as not done" }).click();
  await expect(
    sheet.getByText("Say why the task was not done, in 3 to 500 characters.").first(),
  ).toBeVisible();
  await bothThemes(page, "not done reason");
  await sheet.getByLabel("Why was it not done?").fill("Fire officer visit moved");
  await sheet.getByRole("button", { name: "Record as not done" }).click();
  await expect(
    main(page).getByRole("status").filter({ hasText: "Task recorded as not done." }),
  ).toBeVisible();
  await page.goto("/tasks?view=mine&status=closed");
  await expect(task(page, title)).toContainText("Not done");
  await expect(task(page, title)).toContainText("Fire officer visit moved");
});

test("a family member is offered neither tasks nor documents", async ({ page }) => {
  await page.context().clearCookies();
  await addDemoPasskey(page, "family");
  await page.goto("/sign-in");
  await page.getByRole("button", { name: "Sign in with a passkey" }).click();
  // A family member's home is their updates.
  await page.waitForURL((url) => url.pathname === "/updates");
  const nav = page.getByRole("navigation", { name: "Modules" });
  await expect(nav.getByRole("link", { name: "Updates" })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Tasks" })).toHaveCount(0);
  await expect(nav.getByRole("link", { name: "Documents" })).toHaveCount(0);
  await page.goto("/tasks");
  await expect(main(page)).toContainText("You do not have access to this");
});
