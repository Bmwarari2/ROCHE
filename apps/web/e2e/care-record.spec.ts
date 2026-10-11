import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import { demoPerson, expectAccessible, signIn } from "./support";

/**
 * Phase 1 slice 9: the person record screens against the demo tenant, as the demo nurse (who may
 * write notes, charts, care plans, assessments and resuscitation records). Each journey uses its
 * own resident, so the journeys can run again on the same database.
 *
 * Residents (packages/db/src/seed/demo.ts): 1 Addie (notes), 2 Ben (no resuscitation record),
 * 3 Cara (vital signs), 4 Dev (body map), 5 Else (care plan), 6 Frank (MUST and DNACPR).
 */

const NURSE = "nurse@example.invalid";

test.describe.configure({ mode: "serial" });

// Sign in once (Better Auth throttles sign-ins) and give every journey the same session.
let session: Awaited<ReturnType<BrowserContext["cookies"]>> = [];

test.beforeAll(async ({ browser }, testInfo) => {
  const context = await browser.newContext({ baseURL: testInfo.project.use.baseURL });
  const page = await context.newPage();
  await signIn(page, NURSE);
  session = await context.cookies();
  await context.close();
});

test.beforeEach(async ({ context }) => {
  await context.addCookies(session);
});

/** The point-of-care header is above the tabs on every section of the record (HZ-001). */
async function expectHeader(page: Page, name: string) {
  const header = page.getByRole("region", { name: "Person details" });
  await expect(header.getByRole("heading", { level: 1, name })).toBeVisible();
  await expect(header.getByText("Resuscitation", { exact: true })).toBeVisible();
  return header;
}

test("hazard HZ-001 hazard HZ-015 the header shows the resuscitation status on every tab, and 'not recorded' as a warning", async ({
  page,
}) => {
  await page.goto(`/people/${demoPerson(2)}`);
  const header = await expectHeader(page, "Ben Sample");
  const status = header.locator("[data-resuscitation]");
  await expect(status).toHaveAttribute("data-resuscitation", "not_recorded");
  await expect(status.getByText("CPR decision not recorded")).toBeVisible();
  await expect(status.locator("svg")).toBeVisible();
  await expect(header.getByText("Food texture (IDDSI)")).toBeVisible();
  await expectAccessible(page, "overview");

  const tabs = page.getByRole("navigation", { name: "Sections of Ben's record" });
  for (const tab of [
    "Care plan",
    "Assessments",
    "Risk assessments",
    "Notes",
    "Charts",
    "Body map",
    "Advance care",
    "Activities and visits",
    "History",
    "Overview",
  ]) {
    await tabs.getByRole("link", { name: tab, exact: true }).click();
    await expect(tabs.getByRole("link", { name: tab, exact: true })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await expect(page.getByRole("heading", { level: 2, name: tab, exact: true })).toBeVisible();
    await expectHeader(page, "Ben Sample");
    await expect(header.getByText("CPR decision not recorded")).toBeVisible();
    await expectAccessible(page, `${tab} tab`);
  }
});

test("a nurse records an activity and a visit with the reason for a restriction", async ({
  page,
}) => {
  await page.goto(`/people/${demoPerson(1)}/activities`);
  await expectHeader(page, "Addie");
  const activity = page.getByRole("region", { name: "Record an activity" });
  await activity.getByLabel("Activity", { exact: true }).fill("Music session");
  await activity.getByRole("radio", { name: "Took part", exact: true }).check();
  await activity.getByRole("radio", { name: "Engaged throughout" }).check();
  await activity.getByRole("button", { name: "Save activity" }).click();
  await expect(activity.getByRole("status")).toHaveText("Activity saved");
  await expect(
    page.getByRole("list", { name: "Activities for Addie" }).getByText("Music session").first(),
  ).toBeVisible();

  const visit = page.getByRole("region", { name: "Record a visit" });
  await visit.getByRole("radio", { name: "A visitor came to see Addie" }).check();
  await visit.getByLabel("Visitor's name").fill("Rhys Example");
  await visit
    .getByRole("group", { name: "Were any restrictions applied?" })
    .getByRole("radio", { name: "Yes" })
    .check();
  await expectAccessible(page, "visit form");
  await visit.getByRole("button", { name: "Save visit" }).click();
  await expect(visit.getByRole("alert")).toContainText("Regulation 9A");
  await visit
    .getByLabel("Why the restriction was needed")
    .fill("Visit in the lounge during an outbreak");
  await visit.getByRole("button", { name: "Save visit" }).click();
  await expect(visit.getByRole("status")).toHaveText("Visit saved");
  await expect(
    page
      .getByRole("list", { name: "Visits for Addie" })
      .getByText("Restriction applied: Visit in the lounge during an outbreak")
      .first(),
  ).toBeVisible();
  await expectAccessible(page, "activities and visits");
});

test("hazard HZ-015 a DNACPR decision recorded on the advance care tab shows in the header on every tab", async ({
  page,
}) => {
  await page.goto(`/people/${demoPerson(6)}/advance-care`);
  await expectHeader(page, "Frank Dummy");
  const form = page.getByRole("region", {
    name: "Record a ReSPECT plan, DNACPR decision or advance care record",
  });
  await form.getByLabel("Type of record").selectOption("dnacpr");
  await expect(form.getByText("A DNACPR decision is always do not attempt CPR.")).toBeVisible();
  await form.getByLabel("Clinician's name").fill("Dr Ivy Example");
  await form.getByLabel("Clinician's role").fill("GP");
  await expectAccessible(page, "advance care form");
  await form.getByRole("button", { name: "Save record" }).click();
  await expect(form.getByRole("status")).toHaveText(
    "Record saved. The header shows the decision in force.",
  );

  const header = page.getByRole("region", { name: "Person details" });
  const status = header.locator("[data-resuscitation]");
  await expect(status).toHaveAttribute("data-resuscitation", "do_not_attempt_cpr");
  await expect(status.getByText("Do not attempt CPR", { exact: true })).toBeVisible();
  await expect(
    status.getByText(/^DNACPR decision completed \d{2}\/\d{2}\/\d{4} by Dr Ivy Example \(GP\)$/),
  ).toBeVisible();
  await expectAccessible(page, "advance care saved");

  await page.goto(`/people/${demoPerson(6)}/notes`);
  await expect(header.getByText("Do not attempt CPR", { exact: true })).toBeVisible();
});

test("hazard HZ-024 a draft care plan is labelled as not in use until it is published with sign-off", async ({
  page,
}) => {
  await page.goto(`/people/${demoPerson(5)}/care-plan`);
  await expectHeader(page, "Else");
  await expectAccessible(page, "care plan");

  // Continue an open draft, or start one (from the plan in use after the first run).
  const continueDraft = page.getByRole("link", { name: "Continue the draft" });
  if ((await continueDraft.count()) > 0) {
    await continueDraft.click();
  } else {
    await page
      .getByRole("button", { name: /^Start (a care plan|a new draft from the plan in use)$/ })
      .click();
  }
  await page.waitForURL(/\/care-plan\/[0-9a-f-]{36}$/);
  await expect(page.getByText("This is a draft", { exact: true })).toBeVisible();
  await expect(page.locator('[data-plan-status="draft"]').first()).toBeVisible();

  const mobility = page.locator("details").filter({
    has: page.locator("summary", { hasText: "Mobility" }),
  });
  if (!(await mobility.evaluate((element) => (element as HTMLDetailsElement).open))) {
    await mobility.locator("summary").click();
  }
  await mobility
    .getByLabel("Need", { exact: true })
    .fill("Walks with a frame and needs one carer to stand.");
  await mobility
    .getByLabel("Outcome, in Else's words")
    .fill("I want to walk to the garden every day.");
  await mobility.getByRole("button", { name: "Save Mobility" }).click();
  await expect(mobility.getByRole("status").first()).toHaveText("Saved");
  await expectAccessible(page, "draft care plan");

  await page.getByRole("button", { name: "Publish the care plan" }).click();
  const sheet = page.getByRole("dialog", { name: "Publish the care plan" });
  await sheet.getByRole("radio", { name: "Else agreed it" }).check();
  await expectAccessible(page, "publish sheet");
  await sheet.getByRole("button", { name: "Publish", exact: true }).click();

  await page.waitForURL(/\/care-plan\?published=1$/);
  await expect(page.getByRole("status").getByText("Care plan published")).toBeVisible();
  const inUse = page.getByRole("region", { name: "The plan in use" });
  await expect(inUse.locator('[data-plan-status="active"]')).toContainText("In use");
  await expect(inUse.getByText("Else agreed the plan on")).toBeVisible();
  await expect(inUse.getByText("I want to walk to the garden every day.")).toBeVisible();
  const versions = page.getByRole("table", { name: /Every version of Else's care plan/ });
  await expect(versions.locator('[data-plan-status="active"]')).toHaveCount(1);
  await expect(versions.locator('[data-plan-status="draft"]')).toHaveCount(0);
  await expectAccessible(page, "published care plan");
});

test("hazard HZ-014 vital signs show the NEWS2 result and the RCP response the API returns", async ({
  page,
}) => {
  await page.goto(`/people/${demoPerson(3)}/charts?record=vitals`);
  await expectHeader(page, "Cara Placeholder");
  const records = page.getByRole("navigation", { name: "Chart to record" });
  await expect(records.getByRole("link", { name: "Vital signs" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  const form = page.getByRole("region", { name: "Record vital signs" });
  await form.getByLabel("Respiration rate (breaths per minute)").fill("22");
  await form.getByLabel("SpO2 (%)").fill("95");
  await form.getByLabel("Systolic blood pressure (mmHg)").fill("105");
  await form.getByLabel("Pulse (beats per minute)").fill("95");
  await form.getByLabel("Temperature (°C)").fill("38.2");
  await form.getByRole("radio", { name: "Air", exact: true }).check();
  await form.getByRole("radio", { name: "Alert", exact: true }).check();
  await expectAccessible(page, "vital signs form");
  await form.getByRole("button", { name: "Save entry" }).click();

  await expect(form.getByRole("status")).toHaveText("Chart entry saved");
  const result = form.getByRole("region", { name: "NEWS2 result" });
  await expect(result.getByRole("heading", { name: "NEWS2 score 6" })).toBeVisible();
  await expect(result.getByText("Clinical risk: Medium")).toBeVisible();
  await expect(result.getByText("Response: Key threshold for urgent response")).toBeVisible();
  await expect(result.getByText("Monitoring: Minimum 1 hourly")).toBeVisible();
  await expect(result.getByRole("table", { name: "How the result was worked out" })).toBeVisible();
  const entry = page
    .getByRole("list", { name: "Vital signs in the last 3 days" })
    .getByRole("listitem")
    .first();
  await expect(entry).toContainText(
    "Respiration rate 22, SpO2 95% on air, systolic 105 mmHg, pulse 95, alert, temperature 38.2 °C",
  );
  await expect(entry).toContainText("Response: Key threshold for urgent response");
  await expectAccessible(page, "NEWS2 result");
});

test("hazard HZ-016 food at a texture other than the prescribed level is refused without a reason", async ({
  page,
}) => {
  await page.goto(`/people/${demoPerson(3)}/charts`);
  const settings = page.getByRole("region", { name: "Chart settings" });
  await settings.getByLabel("Prescribed food level (IDDSI)").selectOption("5");
  await settings.getByLabel("Who advised the IDDSI levels").fill("Speech and language therapist");
  await settings.getByRole("button", { name: "Save chart settings" }).click();
  await expect(settings.getByRole("status")).toHaveText("Chart settings saved");
  const header = await expectHeader(page, "Cara Placeholder");
  await expect(header.getByText("Level 5 Minced and moist (orange)")).toBeVisible();

  await page
    .getByRole("navigation", { name: "Chart to record" })
    .getByRole("link", { name: "Food" })
    .click();
  const form = page.getByRole("region", { name: "Record food" });
  const level = form.getByLabel("Texture given (IDDSI food level)");
  await expect(level).toHaveAccessibleDescription(
    /Prescribed: Level 5 Minced and moist \(orange\)/,
  );
  await form.getByLabel("Meal", { exact: true }).selectOption("lunch");
  await form.getByRole("radio", { name: "Half" }).check();
  await level.selectOption("6");
  await expect(form.getByLabel("Reason for giving a different level")).toBeVisible();
  await form.getByRole("button", { name: "Save entry" }).click();
  const refusal = form.getByRole("alert");
  await expect(refusal).toContainText(
    "This is not the prescribed food level (Level 5 Minced and moist (orange)) and may not be safe. Give an override reason.",
  );
  await expectAccessible(page, "IDDSI refusal");

  await form
    .getByLabel("Reason for giving a different level")
    .fill("Soft diet trial agreed by the dietitian today");
  await form.getByRole("button", { name: "Save entry" }).click();
  await expect(form.getByRole("status")).toHaveText("Chart entry saved");
  await expect(
    page
      .getByRole("list", { name: "Food in the last 3 days" })
      .getByText(
        "Not the prescribed level. Reason given: Soft diet trial agreed by the dietitian today",
      )
      .first(),
  ).toBeVisible();
});

test("hazard HZ-019 a body map mark whose side in words differs from the drawing is refused", async ({
  page,
}) => {
  await page.goto(`/people/${demoPerson(4)}/body-map`);
  await expectHeader(page, "Dev Fixture");
  const form = page.getByRole("region", { name: "Record a mark" });
  const drawing = form.getByRole("img", { name: /^Body drawing, front view/ });
  await expect(drawing).toBeVisible();
  await expectAccessible(page, "body map");

  // The front view faces you: the knee on your right is the person's left knee.
  await drawing.click({ position: { x: 142, y: 346 } });
  const area = form.getByLabel("Body area, as marked on the drawing");
  await expect(area).toHaveValue("knee:left");
  await expect(form.getByText("Marked on the drawing: Knee, the person's left")).toBeVisible();

  await form.getByRole("radio", { name: "Right", exact: true }).check();
  await form.getByLabel("Type of mark").selectOption("bruise");
  await form.getByRole("radio", { name: "Yes", exact: true }).check();
  await form.getByRole("button", { name: "Save mark" }).click();
  await expect(form.getByRole("alert")).toContainText(
    "The mark is drawn on the person's left but the person's right was chosen. Check the side and try again.",
  );
  await expectAccessible(page, "body map refusal");

  // The list is the same as the drawing for keyboard and screen reader users.
  await area.selectOption("knee:right");
  await expect(form.getByText("Marked on the drawing: Knee, the person's right")).toBeVisible();
  await form.getByRole("button", { name: "Save mark" }).click();
  await expect(form.getByRole("status").filter({ hasText: "Mark saved" })).toBeVisible();
  await expect(
    page
      .getByRole("table", { name: /Marks on Dev's skin/ })
      .getByRole("rowheader", { name: "Knee, person's right, front" })
      .first(),
  ).toBeVisible();
});

test("hazard HZ-012 a nurse runs MUST and sees the API's score, band, workings and follow-ups", async ({
  page,
}) => {
  await page.goto(`/people/${demoPerson(6)}/assessments`);
  await expectHeader(page, "Frank Dummy");
  await expectAccessible(page, "assessments");
  await page.getByRole("link", { name: "Run MUST" }).click();
  await page.waitForURL(/\?run=must$/);

  const form = page.getByRole("region", { name: "Run MUST" });
  // BMI 50 / 1.65² = 18.4 (2 points); 9% unplanned loss (1 point); no acute disease effect.
  await form.getByLabel("Weight (kg)", { exact: true }).fill("50");
  await form.getByLabel("Height (m)").fill("1.65");
  await form.getByLabel("Weight 3 to 6 months ago (kg)").fill("55");
  await form.getByLabel("Weight now (kg)").fill("50");
  await form
    .getByRole("group", { name: /acutely ill/ })
    .getByRole("radio", { name: "No", exact: true })
    .check();
  await expectAccessible(page, "MUST form");
  await form.getByRole("button", { name: "Calculate and save" }).click();

  await expect(form.getByRole("status")).toHaveText("Result saved");
  const result = form.getByRole("region", { name: "Malnutrition Universal Screening Tool (MUST)" });
  await expect(result.getByText("Score 3", { exact: true })).toBeVisible();
  await expect(result.getByText("High risk", { exact: true })).toBeVisible();
  await expect(result.getByRole("table", { name: "How the result was worked out" })).toBeVisible();
  await expect(result.getByText(/^Task: MUST high risk: refer to dietitian/)).toBeVisible();
  await expect(result.getByText(/^Next due \d{2}\/\d{2}\/\d{4}$/)).toBeVisible();
  await expectAccessible(page, "MUST result");
});

test("a nurse records a risk assessment with the likelihood and severity as judgements", async ({
  page,
}) => {
  await page.goto(`/people/${demoPerson(2)}/risk-assessments`);
  await expectHeader(page, "Ben Sample");
  await page.getByLabel("Template").selectOption("going_out_alone");
  await page.getByRole("button", { name: "Start the assessment" }).click();
  await page.waitForURL(/\?template=going_out_alone$/);

  const form = page.getByRole("region", { name: "Going out alone" });
  await form
    .getByLabel("What is the hazard?")
    .fill("Ben wants to walk to the newsagent on his own.");
  await form.getByLabel("Who is at risk?").fill("Ben");
  // The template's questions: every one needs an answer.
  const questions = form.getByRole("group", { name: "Questions from the template" });
  for (const question of await questions.getByRole("group").all()) {
    await question.getByRole("radio", { name: "Yes", exact: true }).check();
  }
  await form
    .getByRole("group", { name: /^How likely is harm, in your/ })
    .getByRole("radio", { name: "3: Possible" })
    .check();
  await form
    .getByRole("group", { name: /^How bad would the harm be, in your/ })
    .getByRole("radio", { name: "3: Moderate" })
    .check();
  await form
    .getByRole("group", { name: /^How likely is harm with/ })
    .getByRole("radio", { name: "2: Unlikely" })
    .check();
  await form
    .getByRole("group", { name: /^How bad would the harm be with/ })
    .getByRole("radio", { name: "3: Moderate" })
    .check();
  await form.getByRole("checkbox", { name: "Card with the home's phone number" }).check();
  await expectAccessible(page, "risk assessment form");
  await form.getByRole("button", { name: "Save risk assessment" }).click();

  await page.waitForURL(/\?saved=/);
  await expect(page.getByRole("status").getByText("Risk assessment saved")).toBeVisible();
  const saved = page
    .getByRole("article")
    .filter({ hasText: "Ben wants to walk to the newsagent on his own." })
    .first();
  await expect(saved.getByText("Rating 9: high risk")).toBeVisible();
  await expect(saved.getByText("After the controls, rating 6: moderate risk")).toBeVisible();
  await expectAccessible(page, "risk assessments");
});

test("a nurse writes a note and corrects it with a reason", async ({ page }) => {
  await page.goto(`/people/${demoPerson(1)}/notes`);
  await expectHeader(page, "Addie");
  await expectAccessible(page, "notes");

  const text = `Addie enjoyed the garden walk and drank a cup of tea (${Date.now()}).`;
  const form = page.getByRole("region", { name: "Write a note" });
  await form.getByLabel("What is it about?").selectOption("activity");
  await form.getByLabel("Note", { exact: true }).fill(text);
  await form.getByRole("button", { name: "Save note" }).click();
  await expect(form.getByRole("status")).toHaveText("Note saved");

  const list = page.getByRole("list", { name: "Notes about Addie" });
  const entry = list.getByRole("listitem").filter({ hasText: text });
  await expect(entry).toHaveCount(1);
  await expect(entry.getByText("Activity")).toBeVisible();
  await expectAccessible(page, "note saved");

  await entry.getByRole("button", { name: "Correct this note" }).click();
  const corrected = text.replace("a cup of tea", "two cups of tea");
  await entry.getByLabel("Corrected note").fill(corrected);
  await entry.getByLabel("Reason for the correction").fill("Wrong number of cups recorded");
  await expectAccessible(page, "correcting a note");
  await entry.getByRole("button", { name: "Save correction" }).click();

  const chain = list.getByRole("listitem").filter({ hasText: corrected });
  await expect(chain).toHaveCount(1);
  await expect(chain.locator("del")).toHaveText(text);
  await expect(chain.locator("ins")).toHaveText(corrected);
  await expect(chain.getByText("Reason: Wrong number of cups recorded")).toBeVisible();
  await expect(
    chain.getByText(/^Corrected by you on \d{2}\/\d{2}\/\d{4} \d{2}:\d{2}$/),
  ).toBeVisible();
  await expectAccessible(page, "corrected note");
});
