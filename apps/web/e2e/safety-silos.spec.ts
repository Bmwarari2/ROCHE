import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import { demoPerson, expectAccessible, signIn } from "./support";

/**
 * Phase 2 slice 62: the safeguarding, complaints and speak-up screens against the demo tenant
 * (SAFE-006, SAFE-011, SAFE-012; ADR-0089). The manager records complaints and safeguarding
 * concerns; the carer reads the protective measures on a person's record and raises a concern
 * about how people are treated; the nurse, appointed Freedom to Speak Up lead by the owner for this
 * run, works the case. The anonymous page is opened signed out and must set no cookie. Each run
 * marks what it writes with the run, so runs never collide. Invented people and words only.
 */

const API_URL = process.env.API_URL ?? "http://localhost:4000";
const DEMO_TENANT = "0194d000-0000-7000-8000-000000000001";
const NURSE = "0194d000-0000-7000-8000-000000000303";
const RUN = `run ${Date.now().toString(36)}`;

test.describe.configure({ mode: "serial" });

const sessions: Record<string, Awaited<ReturnType<BrowserContext["cookies"]>>> = {};

test.beforeAll(async ({ browser }, testInfo) => {
  for (const user of ["owner", "manager", "nurse", "carer"]) {
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

/** Axe in the light and the dark theme. */
async function accessibleInBothThemes(page: Page, name: string) {
  await page.emulateMedia({ colorScheme: "dark" });
  await expectAccessible(page, `${name} (dark)`);
  await page.emulateMedia({ colorScheme: "light" });
  await expectAccessible(page, `${name} (light)`);
}

/** Fills a date and time field's boxes, found by the field's legend. */
async function fillWhen(page: Page, legend: string, at: Date, time = true) {
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
  if (time) {
    await group.getByLabel("Hour").fill(part("hour"));
    await group.getByLabel("Minute").fill(part("minute"));
  }
}

test("SAFE-011 the manager records a complaint, acknowledges it, and records a compliment", async ({
  page,
  context,
}) => {
  await as(context, "manager");
  await page.goto("/complaints");
  await expect(page.getByRole("heading", { level: 1, name: "Complaints" })).toBeVisible();
  await accessibleInBothThemes(page, "complaints list");

  await page.getByRole("link", { name: "Record a complaint" }).click();
  await page.getByLabel("Name of the person complaining").fill("Pat Example");
  await page
    .getByRole("group", { name: "Who they are" })
    .getByLabel("Family member or friend")
    .check();
  await page.getByRole("group", { name: "How it arrived" }).getByLabel("Email").check();
  const yesterday = new Date(Date.now() - 86_400_000);
  await fillWhen(page, "When it was received", yesterday);
  await fillWhen(page, "When they first knew of the matter", yesterday, false);
  await page.getByLabel("What the complaint is about").fill(`Lunch arrives cold (${RUN}).`);
  await accessibleInBothThemes(page, "new complaint form");
  await page.getByRole("button", { name: "Record complaint" }).click();

  await page.waitForURL(/\/complaints\/[0-9a-f-]{36}$/);
  await expect(page.getByText("Received", { exact: true })).toBeVisible();
  await expect(page.getByText(/Acknowledge by \d{2}\/\d{2}\/\d{4}/).first()).toBeVisible();
  await accessibleInBothThemes(page, "complaint record");
  await page.getByRole("button", { name: "Acknowledge", exact: true }).click();
  await expect(page.getByText("Acknowledged", { exact: true })).toBeVisible();

  await page.goto("/complaints/compliments");
  await page.getByLabel("Who it is from").fill("Sam Example");
  await page
    .getByRole("group", { name: "Who they are" })
    .getByLabel("Family member or friend")
    .check();
  await fillWhen(page, "When it was received", yesterday);
  await page.getByLabel("What they said").fill(`Thank you for the birthday tea (${RUN}).`);
  await page.getByRole("button", { name: "Record compliment" }).click();
  await expect(page.getByText(`Thank you for the birthday tea (${RUN}).`)).toBeVisible();
  await accessibleInBothThemes(page, "compliments");
});

test("SAFE-006 the manager raises a safeguarding concern; the carer sees only its measures", async ({
  page,
  context,
}) => {
  const person = demoPerson(1);
  await as(context, "manager");
  await page.goto(`/safeguarding/new?person=${person}`);
  await page
    .getByRole("group", { name: "What kind of abuse or neglect" })
    .getByLabel("Neglect or acts of omission")
    .check();
  await page.getByLabel("What happened").fill(`Left without water overnight (${RUN}).`);
  await page.getByLabel("Protective measures").fill(`Offer water every two hours (${RUN}).`);
  await accessibleInBothThemes(page, "raise a safeguarding concern");
  await page.getByRole("button", { name: "Raise concern" }).click();
  await page.waitForURL(/\/safeguarding\/[0-9a-f-]{36}$/);
  await expect(page.getByText("Concern raised", { exact: true })).toBeVisible();
  await accessibleInBothThemes(page, "safeguarding concern");

  await page.goto("/safeguarding");
  await expect(page.getByRole("heading", { level: 1, name: "Safeguarding log" })).toBeVisible();
  await accessibleInBothThemes(page, "safeguarding log");

  await as(context, "carer");
  await page.goto(`/people/${person}/safeguarding`);
  await expect(page.getByText(`Offer water every two hours (${RUN}).`)).toBeVisible();
  await expect(page.getByText(`Left without water overnight (${RUN}).`)).toHaveCount(0);
  await accessibleInBothThemes(page, "safeguarding measures tab");
  // The log itself is not the carer's.
  await page.goto("/safeguarding");
  await expect(page.getByText("You do not have access", { exact: false })).toBeVisible();
});

test("hazard HZ-126 the carer raises a concern from the menu and the record, and is told it was raised", async ({
  page,
  context,
}) => {
  const person = demoPerson(2);
  await as(context, "carer");
  await page.goto("/");
  // The menu takes a carer straight to raising a concern; nobody is chosen for them.
  await page.getByRole("navigation").getByRole("link", { name: "Safeguarding" }).first().click();
  await page.waitForURL(/\/safeguarding\/new$/);
  await expect(page.getByLabel("Who it is about")).toHaveValue("");
  await accessibleInBothThemes(page, "raise a safeguarding concern as a carer");

  // From the person's record, the person is chosen.
  await page.goto(`/people/${person}/safeguarding`);
  await page.getByRole("link", { name: /^Raise a safeguarding concern about / }).click();
  await page.waitForURL(/\/safeguarding\/new\?person=/);
  await expect(page.getByLabel("Who it is about")).toHaveValue(person);
  await page
    .getByRole("group", { name: "What kind of abuse or neglect" })
    .getByLabel("Psychological", { exact: true })
    .check();
  await page.getByLabel("What happened").fill(`Shouted at during breakfast (${RUN}).`);
  await page.getByRole("button", { name: "Raise concern" }).click();
  // The carer cannot open the concern, so they stay here and are told it was raised.
  await expect(page.getByRole("heading", { name: "Concern raised" })).toBeFocused();
  await expect(page).toHaveURL(/\/safeguarding\/new/);
  await accessibleInBothThemes(page, "concern raised by a carer");

  // The manager is asked what will happen to the measures, as a question.
  await as(context, "manager");
  await page.goto("/safeguarding");
  await page
    .getByRole("link", { name: /Concern raised/ })
    .first()
    .click();
  await expect(
    page.getByRole("group", {
      name: "What will happen to the protective measures when the concern ends?",
    }),
  ).toBeVisible();
});

test("SAFE-012 the carer speaks up in confidence; the lead acknowledges it and replies", async ({
  page,
  context,
}) => {
  await as(context, "owner");
  const appointed = await context.request.put(`${API_URL}/v1/speak-up/lead`, {
    headers: { "x-harbour-tenant": DEMO_TENANT },
    data: { tenantUserId: NURSE, appoint: true },
  });
  expect(appointed.status(), await appointed.text()).toBe(200);

  await as(context, "carer");
  await page.goto("/speak-up");
  await expect(page.getByRole("heading", { level: 1, name: "Speak up" })).toBeVisible();
  await accessibleInBothThemes(page, "speak up");
  await page
    .getByRole("group", { name: "Who may know it was you" })
    .getByLabel("Confidential")
    .check();
  await page.getByLabel("What it is about").selectOption("conduct");
  await page.getByLabel("What happened").fill(`Shouting at residents on nights (${RUN}).`);
  await page.getByRole("button", { name: "Send to the Freedom to Speak Up lead" }).click();
  await expect(page.getByText(`Shouting at residents on nights (${RUN}).`)).toBeVisible();

  await as(context, "nurse");
  await page.goto("/speak-up/cases");
  await expect(page.getByRole("heading", { level: 1, name: "Speak-up cases" })).toBeVisible();
  await accessibleInBothThemes(page, "speak-up cases");
  await page
    .getByRole("link", { name: /How someone behaves/ })
    .first()
    .click();
  await expect(page.getByText(`Shouting at residents on nights (${RUN}).`)).toBeVisible();
  await accessibleInBothThemes(page, "speak-up case");
  await page.getByRole("button", { name: "Acknowledge", exact: true }).click();
  await expect(page.getByText("Acknowledged", { exact: true })).toBeVisible();
  await page
    .getByLabel("Write to the person who raised it")
    .fill(`Thank you, we are looking into it (${RUN}).`);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByText(`Thank you, we are looking into it (${RUN}).`)).toBeVisible();

  // The owner holds every wider permission and still sees no case.
  await as(context, "owner");
  await page.goto("/speak-up/cases");
  await expect(page.getByText(`Shouting at residents on nights (${RUN}).`)).toHaveCount(0);

  await as(context, "carer");
  await page.goto("/speak-up");
  await expect(page.getByText(`Thank you, we are looking into it (${RUN}).`)).toBeVisible();
});

test("SAFE-012 the anonymous page explains anonymity, sets no cookie, and opens replies only by code", async ({
  browser,
}, testInfo) => {
  const context = await browser.newContext({ baseURL: testInfo.project.use.baseURL });
  const page = await context.newPage();
  await page.goto(`/speak-up-anonymously/${DEMO_TENANT}`);
  await expect(page.getByRole("heading", { level: 1, name: "Speak up anonymously" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "What anonymous means here" })).toBeVisible();
  await expect(page.getByText(/does not keep your IP address/)).toBeVisible();
  await accessibleInBothThemes(page, "anonymous speak-up page");

  await page.getByLabel("What it is about").selectOption("care_quality_or_safety");
  await page.getByLabel("What happened").fill(`Night checks are skipped (${RUN}).`);
  await page.getByLabel("I want a reply code so I can read replies").check();
  await page.getByRole("button", { name: "Send anonymously" }).click();
  const code = page.getByLabel("Reply code").first();
  await expect(code).toHaveValue(/^[A-Za-z0-9_-]{43}$/);
  const token = await code.inputValue();
  expect(page.url()).not.toContain(token);
  await accessibleInBothThemes(page, "anonymous concern sent");

  // Nothing about the person is kept in the browser.
  expect(await context.cookies()).toEqual([]);
  expect(await page.evaluate(() => window.localStorage.length + window.sessionStorage.length)).toBe(
    0,
  );

  // Reading replies needs the code typed back in.
  const fresh = await context.newPage();
  await fresh.goto(`/speak-up-anonymously/${DEMO_TENANT}`);
  await fresh.getByRole("textbox", { name: "Reply code" }).fill(token);
  await fresh.getByRole("button", { name: "Read replies" }).click();
  await expect(fresh.getByText("Received", { exact: true })).toBeVisible();
  expect(await context.cookies()).toEqual([]);
  await context.close();
});
