import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import { expectAccessible, PASSWORD, signIn } from "./support";

/**
 * Phase 1 slice 11 web: a location's downtime page (OPS-028; hazards HZ-017 and HZ-021) against
 * the demo tenant. The nurse (clinical lead: operations.downtime.read and .manage) declares,
 * corrects, reconciles, cancels and closes outages on the screens, and opens and prints the
 * downtime pack with a fresh sign-in; the carer is offered none of it. Outages at a location never
 * overlap, so the journey uses windows in the last hour and expects the fresh database the e2e
 * job prepares. Every state is checked with axe.
 */

const DEMO_LOCATION = "0194d000-0000-7000-8000-000000000101";
const RUN = `run ${Date.now().toString(36)}`;
const T0 = Date.now();

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

/** A moment `minutes` from the start of the run, as the UK wall clock the boxes ask for. */
function ukParts(minutes: number): Record<"day" | "month" | "year" | "hour" | "minute", string> {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/London",
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(new Date(T0 + minutes * 60_000))
      .map((p) => [p.type, p.value]),
  );
  return {
    day: parts.day ?? "",
    month: parts.month ?? "",
    year: parts.year ?? "",
    hour: parts.hour ?? "",
    minute: parts.minute ?? "",
  };
}

async function fillWhen(page: Page, legend: string, minutes: number) {
  const group = page.getByRole("group", { name: legend });
  const parts = ukParts(minutes);
  for (const [box, label] of [
    ["day", "Day"],
    ["month", "Month"],
    ["year", "Year"],
    ["hour", "Hour"],
    ["minute", "Minute"],
  ] as const) {
    await group.getByLabel(label, { exact: true }).fill(parts[box]);
  }
}

const main = (page: Page) => page.getByRole("main");
const alertIn = (page: Page) => main(page).getByRole("alert");
const arrival = (page: Page) => page.locator("[data-arrival-notice]");

async function openLocation(page: Page) {
  await page.goto(`/downtime/${DEMO_LOCATION}`);
  await expect(page.getByRole("heading", { level: 1, name: "Downtime" })).toBeVisible();
}

async function declare(
  page: Page,
  kind: string,
  description: string,
  startMinutes: number,
  endMinutes?: number,
) {
  await openLocation(page);
  const form = page.getByRole("region", { name: "Declare an outage" });
  await form.getByRole("radio", { name: kind }).check();
  await form.getByLabel("What happened").fill(description);
  await fillWhen(page, "When did it start?", startMinutes);
  if (endMinutes !== undefined) await fillWhen(page, "When did it end? (optional)", endMinutes);
  await form.getByRole("button", { name: "Declare outage" }).click();
  await page.waitForURL(/\/downtime\/[^/]+\/outages\/[^/?]+\?done=declared$/);
  await expect(arrival(page)).toHaveText("Outage declared.");
  await expect(arrival(page)).toBeFocused();
}

test("the carer is offered no downtime page", async ({ page, context }) => {
  await as(context, "carer");
  await page.goto("/");
  await expect(
    page.getByRole("navigation", { name: "Modules" }).getByRole("link", { name: "Downtime" }),
  ).toHaveCount(0);
  await page.goto(`/downtime/${DEMO_LOCATION}`);
  await expect(page.getByText("You do not have access to this.", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "Declare outage" })).toHaveCount(0);
  await expectAccessible(page, "downtime page refused");
});

test("hazard HZ-017 the nurse declares, corrects and reconciles an outage, every state in words", async ({
  page,
  context,
}) => {
  await as(context, "nurse");
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "Modules" })
    .getByRole("link", { name: "Downtime" })
    .click();
  await page.waitForURL((url) => url.pathname.startsWith("/downtime"));
  if (new URL(page.url()).pathname === "/downtime") {
    await expectAccessible(page, "downtime locations");
    await main(page).getByRole("link", { name: "Harbour House" }).click();
  }
  await page.waitForURL((url) => url.pathname === `/downtime/${DEMO_LOCATION}`);
  await expect(page.getByRole("region", { name: "Downtime pack" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Outages" })).toBeVisible();
  await expectAccessible(page, "downtime page");

  // Nothing is chosen for the person: an empty form is refused, the summary takes focus.
  const form = page.getByRole("region", { name: "Declare an outage" });
  await form.getByRole("button", { name: "Declare outage" }).click();
  await expect(alertIn(page)).toBeFocused();
  await expect(alertIn(page)).toContainText("Choose what has stopped working");
  await expect(form.getByRole("radio", { name: "Power cut" })).not.toBeChecked();
  await expectAccessible(page, "declare outage refused");

  // Declared after it ended: closed at once, so its paper records can be entered.
  await declare(page, "Power cut", `The power went off in the east wing (${RUN}).`, -60, -40);
  await expect(
    main(page).getByText("Closed: paper records to enter", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("region", { name: "Reconcile the paper records" })).toBeVisible();
  await expectAccessible(page, "closed outage");

  // Correct the start, with the reason the API needs.
  await page.getByRole("button", { name: "Correct the times" }).click();
  await expect(
    page.getByRole("group", { name: "When did it really start?" }).getByLabel("Day"),
  ).toBeFocused();
  await fillWhen(page, "When did it really start?", -55);
  await fillWhen(page, "When did it really end?", -40);
  await page
    .getByLabel("Why are the times being corrected?")
    .fill("The generator log shows 5 minutes later.");
  await page.getByRole("button", { name: "Correct times", exact: true }).click();
  await page.waitForURL(/\?done=corrected$/);
  await expect(arrival(page)).toHaveText("Outage times corrected.");
  await expect(main(page).getByText("The generator log shows 5 minutes later.")).toBeVisible();

  // Reconcile: the statement is required, then the outage is final.
  const reconcile = page.getByRole("region", { name: "Reconcile the paper records" });
  await reconcile.getByRole("button", { name: "Confirm reconciled" }).click();
  await expect(alertIn(page)).toBeFocused();
  await expect(alertIn(page)).toContainText("Say what was checked");
  await expectAccessible(page, "reconcile refused");
  await reconcile.getByLabel("What was checked").fill("No paper forms were used.");
  await reconcile.getByRole("button", { name: "Confirm reconciled" }).click();
  await page.waitForURL(/\?done=reconciled$/);
  await expect(arrival(page)).toHaveText("Outage reconciled.");
  await expect(main(page).getByText("Reconciled", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Correct the times" })).toHaveCount(0);
  await expectAccessible(page, "reconciled outage");
});

test("the nurse cancels an outage declared in error, and closes another when systems are back", async ({
  page,
  context,
}) => {
  await as(context, "nurse");
  await declare(page, "Network down", `The router restarted (${RUN}).`, -30);
  await expect(main(page).getByText("Open", { exact: true })).toBeVisible();
  await expectAccessible(page, "open outage");

  await page.getByRole("button", { name: "Cancel the outage" }).click();
  await expect(page.getByLabel("Why is it being cancelled?")).toBeFocused();
  await page.getByRole("button", { name: "Cancel outage", exact: true }).click();
  await expect(alertIn(page)).toBeFocused();
  await expect(alertIn(page)).toContainText("Say why the outage is being cancelled");
  await page
    .getByLabel("Why is it being cancelled?")
    .fill("Declared in error: the network was fine.");
  await page.getByRole("button", { name: "Cancel outage", exact: true }).click();
  await page.waitForURL(/\?done=cancelled$/);
  await expect(arrival(page)).toHaveText("Outage cancelled.");
  await expect(main(page).getByText("Cancelled", { exact: true })).toBeVisible();
  await expectAccessible(page, "cancelled outage");

  await declare(page, "Harbour not available", `Harbour could not be reached (${RUN}).`, -20);
  // While it is open, no second outage can be declared.
  await openLocation(page);
  await expect(page.getByRole("button", { name: "Declare outage" })).toHaveCount(0);
  await expect(
    page.getByText("An outage is open at this location. Close it before declaring another:"),
  ).toBeVisible();
  await page
    .getByRole("region", { name: "Declare an outage" })
    .getByRole("link", { name: /^Harbour not available, from / })
    .click();
  await page.getByRole("button", { name: "Close the outage" }).click();
  await fillWhen(page, "When did systems come back?", 0);
  await page.getByRole("button", { name: "Close outage", exact: true }).click();
  await page.waitForURL(/\?done=closed$/);
  await expect(arrival(page)).toHaveText(
    "Outage closed. Paper records from it can now be entered.",
  );
  await expect(main(page).getByText(/^Paper records to be entered by /)).toBeVisible();
  await expectAccessible(page, "outage closed");
});

test("hazard HZ-021 the nurse opens the pack with its freshness in words and prints it, never kept", async ({
  page,
  context,
}) => {
  await as(context, "nurse");
  await openLocation(page);
  await page.getByRole("link", { name: "Open the pack" }).click();
  // The pack is a whole-home record: a session older than the step-up window signs in again.
  await page.waitForURL((url) => /\/(sign-in|downtime\/[^/]+\/pack)$/.test(url.pathname));
  if (new URL(page.url()).pathname === "/sign-in") {
    await expect(page.getByText("Confirm it is you")).toBeVisible();
    await page.getByLabel("Email address").fill("nurse@example.invalid");
    await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
  }
  await page.waitForURL((url) => url.pathname === `/downtime/${DEMO_LOCATION}/pack`);
  await expect(page.getByRole("heading", { level: 1, name: "Downtime pack" })).toBeVisible();
  await expect(
    main(page).getByText(
      /^(In date|Latest available during the outage|Out of date|Check this device's clock)$/,
    ),
  ).toBeVisible();
  await expect(page.getByRole("region", { name: "On every printed page" })).toBeVisible();
  await expect(main(page).getByText(/^The printed pack has \d+ /)).toBeVisible();
  await expectAccessible(page, "downtime pack");

  const printed = await page.request.get(`/downtime/${DEMO_LOCATION}/pack/print`, {
    maxRedirects: 0,
  });
  expect(printed.status()).toBe(200);
  expect(printed.headers()["content-type"]).toBe("application/pdf");
  expect(printed.headers()["cache-control"]).toContain("no-store");
  expect(printed.headers()["content-disposition"]).toMatch(/^attachment/);
});
