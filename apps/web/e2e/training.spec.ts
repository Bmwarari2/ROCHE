import { type BrowserContext, expect, type Locator, type Page, test } from "@playwright/test";
import { expectAccessible, signIn, signInWithDemoPasskey } from "./support";

/**
 * The training screens (plan slice 57; WORK-005, WORK-008, WORK-009, WORK-012) against the demo
 * tenant. The manager sets the care worker role's fire safety requirement (refused in words first),
 * reads the organisation's training matrix by role and to those needing attention, records the
 * demo carer's fire safety training, signs off a competence they observed and withdraws it with a
 * reason, records a supervision with what was discussed, and records the demo nurse's revalidation
 * evidence; on their own record they are offered nothing. The carer is offered none of it and is
 * refused in words. Hazard verified: HZ-119 (a competence is signed off in the observer's name and
 * a withdrawal stops it at once, said in words). Every state is checked with axe.
 *
 * Permission findings (07/11/2026): the demo nurse, a clinical lead holding
 * workforce.competence.observe and no staff file permission (the demo seed has no team leader),
 * records a Care Certificate observation from the carer's training record, announced and focused
 * on arrival. HR (the manager) names the owner as the nurse's revalidation confirmer; only the
 * owner is offered the confirmation, and the manager, who could confirm but was not named, is not.
 */

/** The demo carer and nurse (packages/db/src/seed/demo.ts). */
const CARER = "0194d000-0000-7000-8000-000000000304";
const NURSE = "0194d000-0000-7000-8000-000000000303";
const MANAGER = "0194d000-0000-7000-8000-000000000302";
const API_URL = process.env.API_URL ?? "http://localhost:4000";
const TENANT = "0194d000-0000-7000-8000-000000000001";
/** Harbour House, where the workforce journey makes the carer's staff file too. */
const DEMO_LOCATION = "0194d000-0000-7000-8000-000000000101";
const OWNER_NAME = "Olive Owner";
const RUN = Date.now().toString(36);

test.describe.configure({ mode: "serial" });

const sessions: Record<string, Awaited<ReturnType<BrowserContext["cookies"]>>> = {};

test.beforeAll(async ({ browser }, testInfo) => {
  test.setTimeout(180_000);
  for (const user of ["manager", "carer", "nurse", "owner"]) {
    const context = await browser.newContext({ baseURL: testInfo.project.use.baseURL });
    const page = await context.newPage();
    if (user === "manager" || user === "owner") await signInWithDemoPasskey(page, user);
    else await signIn(page, `${user}@example.invalid`);
    sessions[user] = await context.cookies();
    await context.close();
  }
});

async function as(page: Page, user: string) {
  await page.context().clearCookies();
  await page.context().addCookies(sessions[user] ?? []);
}

const main = (page: Page) => page.getByRole("main");
const nav = (page: Page) => page.getByRole("navigation", { name: "Modules" });
const form = (page: Page, name: string) => main(page).getByRole("form", { name });
const status = (page: Page, text: string) =>
  main(page).getByRole("status").filter({ hasText: text });

/** Today in the UK, as the API's dates are, and a day so many days from it. */
function ukDay(offsetDays = 0) {
  const day = new Date(Date.now() + offsetDays * 86_400_000);
  const [year, month, date] = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" })
    .format(day)
    .split("-");
  return { day: date ?? "", month: month ?? "", year: year ?? "" };
}

async function fillDate(group: Locator, offsetDays = 0) {
  const when = ukDay(offsetDays);
  await group.getByLabel("Day", { exact: true }).fill(when.day);
  await group.getByLabel("Month", { exact: true }).fill(when.month);
  await group.getByLabel("Year", { exact: true }).fill(when.year);
}

test("the carer is offered no training screens and is refused in words", async ({ page }) => {
  await as(page, "carer");
  await page.goto("/");
  await expect(nav(page).getByRole("link", { name: "Training", exact: true })).toHaveCount(0);
  for (const path of ["/training", "/training/requirements", `/training/${NURSE}`]) {
    await page.goto(path);
    await expect(main(page)).toContainText("You do not have access to this");
  }
  await expectAccessible(page, "training refused");
});

test("the manager sets a role's requirement, with errors in words first", async ({ page }) => {
  await as(page, "manager");
  await page.goto("/");
  await nav(page).getByRole("link", { name: "Training", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Training matrix" })).toBeVisible();
  await main(page).getByRole("link", { name: "Training requirements" }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Training requirements" }),
  ).toBeVisible();
  const set = form(page, "Set a role's requirement");
  await set.getByRole("button", { name: "Save requirement" }).click();
  await expect(set).toContainText("Choose the role");
  await expect(set).toContainText("Choose the training topic");
  await expectAccessible(page, "requirement errors");

  await set.getByLabel("Role", { exact: true }).selectOption("care_worker");
  await set.getByLabel("Topic").selectOption("fire_safety");
  await set.getByRole("button", { name: "Save requirement" }).click();
  await expect(status(page, "The requirement has been saved")).toBeVisible();
  await expect(
    main(page).getByRole("heading", { level: 2, name: "Care or support worker" }),
  ).toBeVisible();
  await expectAccessible(page, "requirements");
});

test("the manager reads the matrix by role and those needing attention", async ({ page }) => {
  await as(page, "manager");
  await page.goto("/training");
  await main(page).getByLabel("Role").selectOption("care_worker");
  await main(page).getByRole("button", { name: "Show matrix" }).click();
  await expect(page).toHaveURL(/role=care_worker/);
  const grid = main(page).getByRole("table", { name: /Training matrix/ });
  await expect(grid.getByRole("columnheader", { name: "Fire safety" })).toBeVisible();
  // The demo carer, by their row's link to their record.
  await expect(grid.locator(`a[href="/training/${CARER}"]`)).toBeVisible();

  // Found by name, in the browser: the name never goes into the address.
  await main(page).getByLabel("Find a member of staff").fill("cat car");
  await expect(
    main(page)
      .getByRole("status")
      .filter({ hasText: /matches?$/ }),
  ).toBeVisible();
  await expect(grid.locator(`a[href="/training/${CARER}"]`)).toBeVisible();
  expect(page.url()).not.toContain("cat%20car");
  expect(page.url()).not.toContain("cat+car");
  await main(page).getByLabel("Find a member of staff").fill("");
  // Every state is a word beside an icon, never a colour alone.
  await expect(grid.getByText(/^(Up to date|Due soon|Lapsed|Not done)$/).first()).toBeVisible();
  await expectAccessible(page, "matrix by role");

  await main(page).getByLabel("Only staff with training not done, lapsed or due soon").check();
  await main(page).getByRole("button", { name: "Show matrix" }).click();
  await expect(page).toHaveURL(/attention=yes/);
  await expectAccessible(page, "matrix needing attention");
});

test("the manager records the carer's training, and their competence (HZ-119)", async ({
  page,
}) => {
  await as(page, "manager");
  await page.goto(`/training/${CARER}`);
  await expect(page.getByRole("heading", { level: 1, name: /^Training record: / })).toBeVisible();

  const training = form(page, "Record training");
  await training.getByLabel("Topic").selectOption("fire_safety");
  await fillDate(training.getByRole("group", { name: "Date completed" }));
  await training.getByLabel("Training provider").fill(`Example Training ${RUN}`);
  await training.getByRole("button", { name: "Record training" }).click();
  await expect(status(page, "The training has been recorded")).toBeVisible();
  const fire = main(page)
    .getByRole("listitem")
    .filter({ has: page.getByRole("heading", { level: 3, name: "Fire safety" }) });
  await expect(fire.getByText("Up to date")).toBeVisible();
  await expectAccessible(page, "training recorded");

  const signOff = form(page, "Sign off a competence you observed");
  await signOff.getByLabel("Competence", { exact: true }).selectOption("medicines_administration");
  await fillDate(signOff.getByRole("group", { name: "Date observed" }));
  await signOff.getByRole("button", { name: "Sign off competence" }).click();
  // The observer confirms in their own name before anything is sent.
  await expect(signOff).toContainText("Tick the box to confirm");
  await signOff.getByRole("checkbox").check();
  await signOff.getByRole("button", { name: "Sign off competence" }).click();
  await expect(status(page, "The competence has been signed off")).toBeVisible();
  const medicines = main(page)
    .getByRole("listitem")
    .filter({ has: page.getByRole("heading", { level: 3, name: "Medicines administration" }) });
  await expect(medicines.getByText("Signed off", { exact: true })).toBeVisible();
  await expectAccessible(page, "competence signed off");

  await main(page)
    .getByText(/^Withdraw Medicines administration observed on /)
    .first()
    .click();
  const withdraw = form(page, "Withdraw this sign-off").first();
  await withdraw.getByLabel("Reason for withdrawing").fill("short");
  await withdraw.getByRole("checkbox").check();
  await withdraw.getByRole("button", { name: "Withdraw sign-off" }).click();
  await expect(withdraw).toContainText("Enter at least 10 characters");
  await withdraw
    .getByLabel("Reason for withdrawing")
    .fill("Observed a missed signature at the evening round");
  await withdraw.getByRole("button", { name: "Withdraw sign-off" }).click();
  await expect(status(page, "The sign-off has been withdrawn")).toBeVisible();
  await expect(medicines.getByText("Sign-off withdrawn")).toBeVisible();
  await expectAccessible(page, "competence withdrawn");
});

test("the manager records a supervision with what was discussed", async ({ page }) => {
  await as(page, "manager");
  await page.goto(`/training/${CARER}`);
  const supervise = form(page, "Record a supervision, appraisal or spot check");
  await supervise.getByLabel("What was held").selectOption("supervision");
  await fillDate(supervise.getByRole("group", { name: "Date held" }));
  await supervise.getByLabel("Actions agreed").fill("Book the refresher");
  await supervise.getByRole("button", { name: "Save supervision record" }).click();
  // Actions need what was discussed too.
  await expect(supervise).toContainText("Enter what was discussed");
  const discussion = `Talked through the night shifts, run ${RUN}.`;
  await supervise.getByLabel("What was discussed").fill(discussion);
  await supervise.getByRole("button", { name: "Save supervision record" }).click();
  await expect(status(page, "Supervision record saved")).toBeVisible();
  await expect(main(page).getByText(discussion)).toBeVisible();
  await expectAccessible(page, "supervision recorded");

  // Whoever held it corrects the note: the earlier one stays, struck through.
  const held = main(page)
    .getByRole("listitem")
    .filter({ has: page.getByText(discussion, { exact: true }) });
  await held.getByText(/^Correct the note: Supervision on /).click();
  const correct = held.getByRole("form", { name: "Correct the note" });
  const corrected = `Talked through the night shifts and the rota, run ${RUN}.`;
  await correct.getByLabel("What was discussed").fill(corrected);
  await correct.getByRole("button", { name: "Save note" }).click();
  await expect(status(page, "The note has been saved")).toBeVisible();
  const after = main(page)
    .getByRole("listitem")
    .filter({ has: page.getByText(corrected, { exact: true }) });
  await expect(
    after.getByRole("heading", { name: "Earlier notes, since corrected" }),
  ).toBeVisible();
  await expect(after.locator("del")).toHaveText(discussion);
  await expectAccessible(page, "note corrected");
});

test("the manager records the nurse's revalidation evidence", async ({ page }) => {
  await as(page, "manager");
  await page.goto(`/training/${NURSE}`);
  const evidence = form(page, "Record revalidation evidence");
  await fillDate(evidence.getByRole("group", { name: "Revalidation date" }), 200);
  await evidence.getByLabel("Practice hours so far").fill("not a number");
  await evidence.getByRole("button", { name: "Save evidence" }).click();
  await expect(main(page)).toContainText("Enter a whole number from 0 to 10000");
  await evidence.getByLabel("Practice hours so far").fill("120");
  await evidence.getByLabel("Pieces of feedback so far").fill("5");
  await evidence.getByRole("button", { name: "Save evidence" }).click();
  await expect(status(page, "The revalidation evidence has been saved")).toBeVisible();
  const planner = main(page)
    .getByRole("region", { name: "NMC revalidation" })
    .or(main(page).locator("section[aria-labelledby='revalidation']"));
  await expect(planner.getByText(/requirements? to do$/)).toBeVisible();
  await expect(planner.getByText("Practice hours", { exact: true })).toBeVisible();
  await expectAccessible(page, "revalidation");
});

test("on their own record the manager is offered nothing to record", async ({ page }) => {
  await as(page, "manager");
  await page.goto(`/training/${MANAGER}`);
  await expect(main(page)).toContainText("This is your own record");
  await expect(main(page).getByRole("form")).toHaveCount(0);
  await expectAccessible(page, "own record");
});

/** A UK date as the API takes it (yyyy-mm-dd), so many days from today. */
function isoDay(offsetDays = 0) {
  const { year, month, day } = ukDay(offsetDays);
  return `${year}-${month}-${day}`;
}

const api = (page: Page) => ({
  get: (path: string) =>
    page.request.get(`${API_URL}${path}`, { headers: { "x-harbour-tenant": TENANT } }),
  send: (method: "POST" | "PUT", path: string, data: unknown) =>
    page.request.fetch(`${API_URL}${path}`, {
      method,
      headers: { "x-harbour-tenant": TENANT },
      data,
    }),
});

/** The h1 takes focus on arrival, described by the status that says what was done. */
async function expectArrival(page: Page, words: string) {
  await expect(status(page, words)).toBeVisible();
  const heading = page.getByRole("heading", { level: 1 });
  await expect(heading).toBeFocused();
  await expect(heading).toHaveAccessibleDescription(words);
}

test("a clinical lead without the staff file records a Care Certificate observation", async ({
  page,
}) => {
  await as(page, "manager");
  // The carer's staff file, made once (409 when an earlier run or the workforce journey made it).
  const made = await api(page).send("POST", "/v1/workforce/staff-files", {
    tenantUserId: CARER,
    locationId: DEMO_LOCATION,
    jobTitle: "Care worker",
    pathwayCategory: "care_worker",
    registrationBody: null,
    previousCareWork: false,
    dateOfBirth: null,
    startsOn: null,
    leftOn: null,
  });
  expect([201, 409], await made.text()).toContain(made.status());
  // A standard at "Knowledge assessed": one from an earlier run, or the next one assessed now.
  const read = await api(page).get(`/v1/workforce/members/${CARER}/care-certificate`);
  expect(read.status(), await read.text()).toBe(200);
  const view = (await read.json()) as {
    staffProfileId: string;
    careCertificate: { standards: { id: string; title: string; status: string }[] };
  };
  let standard = view.careCertificate.standards.find((s) => s.status === "knowledge_assessed");
  if (!standard) {
    standard = view.careCertificate.standards.find((s) => s.status === "not_started");
    test.skip(!standard, "Every Care Certificate standard is already competent on this database");
    if (!standard) return;
    const assessed = await api(page).send(
      "PUT",
      `/v1/workforce/staff-files/${view.staffProfileId}/care-certificate/${standard.id}`,
      { step: "knowledge", on: isoDay(0) },
    );
    expect(assessed.status(), await assessed.text()).toBe(200);
  }

  await as(page, "nurse");
  await page.goto(`/training/${CARER}`);
  const section = main(page).locator("section[aria-labelledby='care-certificate']");
  await expect(section.getByRole("heading", { name: "Care Certificate" })).toBeVisible();
  const card = section
    .getByRole("listitem")
    .filter({ has: page.getByRole("heading", { name: standard.title, exact: true }) });
  await expect(card).toContainText("Knowledge assessed");
  await expectAccessible(page, "care certificate for an observer");
  const observe = card.getByRole("form", { name: `Record observed competent: ${standard.title}` });
  await fillDate(observe.getByRole("group", { name: "Date observed" }), 0);
  await observe
    .getByRole("button", { name: `Record observed competent: ${standard.title}` })
    .click();
  await expectArrival(page, "The observation has been recorded");
  await expect(card).toContainText("Competent");
  await expect(card.getByRole("form")).toHaveCount(0);
  await expectAccessible(page, "care certificate observed");
});

test("HR names the revalidation confirmer; only the named confirmer records the confirmation", async ({
  page,
}) => {
  await as(page, "manager");
  // A cycle of this run's own, later than any earlier run's, so the planner shows it.
  const hours = Math.floor((Date.now() - Date.UTC(2026, 10, 1)) / 3_600_000);
  let cycle = "";
  let version = 0;
  for (let i = 0; i < 50 && !cycle; i += 1) {
    const when = isoDay(400 + hours + i);
    const saved = await api(page).send("PUT", `/v1/workforce/members/${NURSE}/revalidation`, {
      cycleDueOn: when,
      practiceHours: 100,
      cpdHours: 10,
      participatoryCpdHours: 5,
      feedbackPieces: 1,
      reflectiveAccounts: 1,
      reflectiveDiscussion: false,
      healthAndCharacter: true,
      professionalIndemnity: true,
    });
    if (saved.status() === 409) continue;
    expect(saved.status(), await saved.text()).toBe(200);
    const plan = ((await saved.json()) as { revalidation: { cycleDueOn: string; version: number } })
      .revalidation;
    expect(plan.cycleDueOn).toBe(when);
    cycle = when;
    version = plan.version;
  }
  expect(cycle).not.toBe("");
  // HR (the manager) reviews it; the reviewer is never the confirmer.
  const reviewed = await api(page).send(
    "POST",
    `/v1/workforce/members/${NURSE}/revalidation/review`,
    { expectedVersion: version, cycleDueOn: cycle },
  );
  expect(reviewed.status(), await reviewed.text()).toBe(200);

  await page.goto(`/training/${NURSE}`);
  const planner = main(page).locator("section[aria-labelledby='revalidation']");
  await expect(planner.getByText("No confirmer named yet")).toBeVisible();
  // HR's evidence form has no confirmation tick, and HR is not offered the confirmation.
  await expect(
    form(page, "Record revalidation evidence").getByRole("checkbox", {
      name: "A confirmer has signed the NMC confirmation",
    }),
  ).toHaveCount(0);
  await expect(form(page, "Record your confirmation")).toHaveCount(0);
  const naming = form(page, "Name the confirmer");
  await naming.getByRole("button", { name: "Save confirmer" }).click();
  await expect(naming).toContainText("Choose a confirmer");
  await expectAccessible(page, "confirmer not chosen");
  await naming.getByLabel("Confirmer", { exact: true }).selectOption({ label: OWNER_NAME });
  await naming.getByRole("button", { name: "Save confirmer" }).click();
  await expectArrival(page, "Confirmer saved");
  await expect(planner.getByText(`Confirmer: ${OWNER_NAME}`)).toBeVisible();
  // The manager could confirm (they hold supervision.manage) but was not named.
  await expect(form(page, "Record your confirmation")).toHaveCount(0);
  await expectAccessible(page, "confirmer named");

  await as(page, "owner");
  await page.goto(`/training/${NURSE}`);
  const confirm = form(page, "Record your confirmation");
  await expect(confirm).toBeVisible();
  await confirm.getByRole("button", { name: "Record confirmation" }).click();
  await expect(confirm).toContainText(
    "Date of the confirmation discussion must include a day, month and year",
  );
  await expect(confirm).toContainText("Tick the box to confirm");
  await expectAccessible(page, "confirmation errors");
  await fillDate(confirm.getByRole("group", { name: "Date of the confirmation discussion" }), 0);
  await confirm
    .getByRole("checkbox", {
      name: "I held the confirmation discussion with Nell Nurse and saw their evidence",
    })
    .check();
  await confirm.getByRole("button", { name: "Record confirmation" }).click();
  await expectArrival(page, "Confirmation recorded");
  const { day, month, year } = ukDay(0);
  await expect(
    main(page)
      .locator("section[aria-labelledby='revalidation']")
      .getByText(`Confirmed by ${OWNER_NAME} on ${day}/${month}/${year}`),
  ).toBeVisible();
  await expect(form(page, "Record your confirmation")).toHaveCount(0);
  await expectAccessible(page, "confirmation recorded");
});
