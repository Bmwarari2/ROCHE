import { type BrowserContext, expect, type Locator, type Page, test } from "@playwright/test";
import { demoPerson, expectAccessible, settleAnimations, signIn } from "./support";

/**
 * Phase 1 slice 9: the person record screens against the demo tenant, as the demo nurse (who may
 * write notes, charts, care plans, assessments and resuscitation records). Each journey uses its
 * own resident, or leaves the resident as it found them, so the journeys can run again on the same
 * database.
 *
 * Residents (packages/db/src/seed/demo.ts): 1 Addie (notes, a colleague's change to the header),
 * 2 Ben (no resuscitation record, no known allergies), 3 Cara (vital signs, IDDSI), 4 Dev (body
 * map; allergic to latex and peanut), 5 Else (care plan), 6 Frank (MUST and DNACPR).
 */

const NURSE = "nurse@example.invalid";
const PEOPLE = "Residents";

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

/**
 * The point-of-care header is above the tabs on every section of the record (HZ-001): the name,
 * allergies, resuscitation status and IDDSI levels, and when it was read.
 */
async function expectHeader(page: Page, name: string, allergies?: string | RegExp) {
  const header = page.getByRole("region", { name: "Person details" });
  await expect(header.getByRole("heading", { level: 1, name })).toBeVisible();
  await expect(header.getByText("Resuscitation", { exact: true })).toBeVisible();
  await expect(header.locator("[data-resuscitation]")).toBeVisible();
  await expect(header.getByText("Allergies", { exact: true }).first()).toBeVisible();
  if (allergies) await expect(header.getByText(allergies).first()).toBeVisible();
  await expect(header.getByText("Food texture (IDDSI)")).toBeVisible();
  await expect(header.getByText("Drink thickness (IDDSI)")).toBeVisible();
  await expect(header.getByText(/^Checked at \d{2}:\d{2}$/)).toBeVisible();
  return header;
}

/** Presses Tab until the target has focus: the keyboard is the only way in. */
async function tabTo(page: Page, target: Locator, limit = 120) {
  for (let presses = 0; presses < limit; presses += 1) {
    if (await target.evaluate((element) => element === document.activeElement)) return;
    await page.keyboard.press("Tab");
  }
  throw new Error("The target could not be reached with the Tab key");
}

const TAB_TITLES: Record<string, string> = {
  Overview: "Overview",
  "Care plan": "Care plan",
  Assessments: "Assessments",
  "Risk assessments": "Risk assessments",
  Notes: "Notes",
  Charts: "Fluid intake | Charts",
  "Body map": "Body map",
  "Advance care": "Advance care",
  "Consent, capacity and DoLS": "Consent, capacity and DoLS",
  "Activities and visits": "Activities and visits",
  History: "History",
};

test("hazard HZ-001 hazard HZ-015 the header shows the resuscitation status, allergies and IDDSI levels on every tab, and 'not recorded' as a warning", async ({
  page,
}) => {
  await page.goto(`/people/${demoPerson(2)}`);
  const header = await expectHeader(page, "Ben Sample", "No known allergies");
  const status = header.locator("[data-resuscitation]");
  await expect(status).toHaveAttribute("data-resuscitation", "not_recorded");
  await expect(status.getByText("CPR decision not recorded")).toBeVisible();
  await expect(status.locator("svg")).toBeVisible();
  await expect(page).toHaveTitle(`Overview | ${PEOPLE} | Harbour`);
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
    "Consent, capacity and DoLS",
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
    // A new title on every tab, so the change of page is announced; never the person's name.
    await expect(page).toHaveTitle(`${TAB_TITLES[tab]} | ${PEOPLE} | Harbour`);
    expect(await page.title()).not.toContain("Ben");
    await expectHeader(page, "Ben Sample", "No known allergies");
    await expect(header.getByText("CPR decision not recorded")).toBeVisible();
    await expectAccessible(page, `${tab} tab`);
  }
  // The breadcrumb no longer claims to be the current page; the tabs do.
  await expect(
    page.getByRole("navigation", { name: "Breadcrumb" }).locator("[aria-current]"),
  ).toHaveCount(0);

  // Every tab passes axe in the dark theme too.
  await page.emulateMedia({ colorScheme: "dark" });
  for (const tab of Object.keys(TAB_TITLES)) {
    await tabs.getByRole("link", { name: tab, exact: true }).click();
    await expect(page).toHaveTitle(`${TAB_TITLES[tab]} | ${PEOPLE} | Harbour`);
    await expectAccessible(page, `${tab} tab in the dark theme`);
  }
  await page.emulateMedia({ colorScheme: "light" });
});

test("hazard HZ-002 hazard HZ-015 a colleague's change to the CPR decision shows in the header after one tab move", async ({
  page,
  browser,
}, testInfo) => {
  const other = await browser.newContext({ baseURL: testInfo.project.use.baseURL });
  await other.addCookies(session);
  const colleague = await other.newPage();

  /** The colleague withdraws every DNACPR decision in force for Addie. */
  async function withdrawDnacpr() {
    await colleague.goto(`/people/${demoPerson(1)}/advance-care`);
    const withdraw = colleague.getByRole("button", { name: "Withdraw this DNACPR decision" });
    while ((await withdraw.count()) > 0) {
      await withdraw.first().click();
      // A destructive action names what it changes, before anything is sent.
      await expect(
        colleague.getByText(
          "The header will then show ‘CPR decision not recorded’ unless another ReSPECT plan or DNACPR decision is in force. The record stays in the history, marked as withdrawn.",
        ),
      ).toBeVisible();
      await expect(colleague.getByLabel("Why it is withdrawn, and by whom")).toBeFocused();
      await colleague
        .getByLabel("Why it is withdrawn, and by whom")
        .fill("Recorded for a test journey, withdrawn by the nurse");
      await colleague.getByRole("button", { name: "Withdraw the DNACPR decision" }).click();
      const arrived = colleague.locator("[data-arrival-notice]");
      await expect(arrived).toHaveText(
        "DNACPR decision withdrawn. Check the CPR decision the header now shows.",
      );
      await expect(arrived).toBeFocused();
    }
  }

  await withdrawDnacpr();
  await page.goto(`/people/${demoPerson(1)}/notes`);
  const header = await expectHeader(page, "Addie", "1 allergy");
  const status = header.locator("[data-resuscitation]");
  await expect(status).toHaveAttribute("data-resuscitation", "not_recorded");

  // The colleague records a DNACPR decision in another session.
  await colleague.goto(`/people/${demoPerson(1)}/advance-care`);
  const form = colleague.getByRole("region", {
    name: "Record a ReSPECT plan, DNACPR decision or advance care record",
  });
  await form.getByLabel("Type of record").selectOption("dnacpr");
  await form.getByLabel("Clinician's name").fill("Dr Ivy Example");
  await form.getByLabel("Clinician's role").fill("GP");
  await form.getByRole("button", { name: "Save record" }).click();
  await expect(form.getByRole("status")).toHaveText(
    "Record saved. The header shows the decision in force.",
  );

  // One tab move reads the header again.
  await page
    .getByRole("navigation", { name: "Sections of Addie's record" })
    .getByRole("link", { name: "Charts", exact: true })
    .click();
  await expect(status).toHaveAttribute("data-resuscitation", "do_not_attempt_cpr");
  await expect(status.getByText("Do not attempt CPR", { exact: true })).toBeVisible();

  // The colleague withdraws it; "Check again" reads the header without moving tab.
  await withdrawDnacpr();
  await header.getByRole("button", { name: "Check again" }).click();
  await expect(status).toHaveAttribute("data-resuscitation", "not_recorded");
  await expectAccessible(page, "header read again");
  await other.close();
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
  // Focus moves to the message, not to a form that was just replaced.
  await expect(activity.getByText("Activity saved")).toBeFocused();
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
  // The refusal is at the reason (aria-invalid and described by it) and the summary links to it.
  const reason = visit.getByLabel("Why the restriction was needed");
  const refusal = visit.getByRole("alert");
  await expect(refusal).toBeFocused();
  await expect(refusal).toContainText("Regulation 9A");
  await expect(reason).toHaveAttribute("aria-invalid", "true");
  await expect(reason).toHaveAccessibleDescription(/Regulation 9A: say why a restriction/);
  await refusal.getByRole("link", { name: /Regulation 9A/ }).click();
  await expect(reason).toBeFocused();
  await expectAccessible(page, "visit refusal");
  await reason.fill("Visit in the lounge during an outbreak");
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
  // The date is in day, month and year boxes, so it reads dd/mm/yyyy in any browser language.
  const completed = form.getByRole("group", { name: "Date completed" });
  await expect(completed.getByRole("textbox", { name: "Day" })).not.toHaveValue("");
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
  await expect(page).toHaveTitle(`Care plan version | Care plan | ${PEOPLE} | Harbour`);
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
  // Nobody is chosen for the person: publishing without saying who agreed is refused there.
  await sheet.getByRole("button", { name: "Publish", exact: true }).click();
  const agreed = sheet.getByRole("group", { name: "Who agreed the plan?" });
  await expect(agreed.getByRole("radio").first()).toHaveAttribute("aria-invalid", "true");
  await sheet.getByRole("radio", { name: "No one could agree it" }).check();
  await sheet.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(sheet.getByLabel("Why no one could agree it")).toHaveAttribute(
    "aria-invalid",
    "true",
  );
  await sheet.getByRole("radio", { name: "Else agreed it" }).check();
  await expectAccessible(page, "publish sheet");
  await sheet.getByRole("button", { name: "Publish", exact: true }).click();

  await page.waitForURL(/\/care-plan\?published=1$/);
  const arrived = page.locator("[data-arrival-notice]");
  await expect(arrived).toHaveText("Care plan published. It is now the plan in use.");
  await expect(arrived).toBeFocused();
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
  await expect(page).toHaveTitle(`Vital signs | Charts | ${PEOPLE} | Harbour`);
  const records = page.getByRole("navigation", { name: "Chart to record" });
  // A choice within the page: announced as current, not as the current page.
  await expect(records.getByRole("link", { name: "Vital signs" })).toHaveAttribute(
    "aria-current",
    "true",
  );
  const form = page.getByRole("region", { name: "Record vital signs" });
  await form.getByLabel("Respiration rate (breaths per minute)").fill("22");
  await form.getByLabel("SpO2 (%)").fill("95");
  await form.getByLabel("Systolic blood pressure (mmHg)").fill("105");
  await form.getByLabel("Pulse (beats per minute)").fill("95");
  await form.getByLabel("Temperature (°C)").fill("38.2");

  // HZ-012: nothing is chosen for air or oxygen and consciousness; leaving them is refused there.
  const oxygen = form.getByRole("group", { name: "Air or oxygen" });
  const consciousness = form.getByRole("group", { name: "Consciousness (ACVPU)" });
  await expect(oxygen.getByRole("radio", { checked: true })).toHaveCount(0);
  await expect(consciousness.getByRole("radio", { checked: true })).toHaveCount(0);
  await form.getByRole("button", { name: "Save entry" }).click();
  await expect(form.getByRole("alert")).toBeFocused();
  await expect(oxygen).toHaveAccessibleDescription("Choose air or oxygen");
  await expect(oxygen.getByRole("radio", { name: "Air", exact: true })).toHaveAttribute(
    "aria-invalid",
    "true",
  );
  await expect(consciousness).toHaveAccessibleDescription("Choose the level of consciousness");
  await expectAccessible(page, "vital signs refused");

  await form.getByRole("radio", { name: "Air", exact: true }).check();
  await form.getByRole("radio", { name: "Alert", exact: true }).check();
  await expectAccessible(page, "vital signs form");
  // Earlier runs left entries with the same readings: wait for this one to join the list.
  const entries = page
    .getByRole("list", { name: "Vital signs in the last 3 days" })
    .getByRole("listitem");
  const before = await entries.count();
  await form.getByRole("button", { name: "Save entry" }).click();
  await expect(entries).toHaveCount(before + 1);

  await expect(form.getByRole("status")).toHaveText("Chart entry saved");
  const result = form.getByRole("region", { name: "NEWS2 result" });
  // Focus moves to the result, so the score and the RCP's response are read out.
  await expect(result).toBeFocused();
  await expect(result.getByRole("heading", { name: "NEWS2 score 6" })).toBeVisible();
  await expect(result.getByText("Clinical risk: Medium")).toBeVisible();
  await expect(result.getByText("Response: Key threshold for urgent response")).toBeVisible();
  await expect(result.getByText("Monitoring: Minimum 1 hourly")).toBeVisible();
  await expect(result.getByRole("table", { name: "How the result was worked out" })).toBeVisible();
  // The result shown and focused after saving names the organisation's policy too, as the saved
  // entry does (HZ-012; #26 review round 3).
  await expect(result).toContainText(
    "Your organisation's escalation policy: Deterioration and escalation policy (CP-07)",
  );
  const entry = entries.first();
  await expect(entry).toContainText(
    "Respiration rate 22, SpO2 95% on air, systolic 105 mmHg, pulse 95, alert, temperature 38.2 °C",
  );
  // The saved entry shows the total and the response, with the workings one tap away.
  await expect(entry).toContainText("NEWS2 score 6");
  await expect(entry).toContainText("Response: Key threshold for urgent response");
  // The demo organisation links its own policy to NEWS2 results (HZ-014; #26 review round 2, C6).
  await expect(entry).toContainText(
    "Your organisation's escalation policy: Deterioration and escalation policy (CP-07)",
  );
  // The entry says who its urgent alert actually reached (#26 review round 3).
  await expect(entry).toContainText("The nurse in charge was told.");
  await entry.getByText("How the score was worked out").click();
  await expect(entry.getByRole("table", { name: "How the result was worked out" })).toBeVisible();
  await expectAccessible(page, "NEWS2 result");

  // The dark theme passes axe too.
  await page.emulateMedia({ colorScheme: "dark" });
  await page.reload();
  await expectAccessible(page, "charts in the dark theme");
  await page.emulateMedia({ colorScheme: "light" });
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
  await expect(page).toHaveTitle(`Food | Charts | ${PEOPLE} | Harbour`);
  const form = page.getByRole("region", { name: "Record food" });
  const level = form.getByLabel("Texture given (IDDSI food level)");
  // The prescribed level shows beside the choice, but nothing is chosen for anyone.
  await expect(level).toHaveAccessibleDescription(
    /Prescribed: Level 5 Minced and moist \(orange\)/,
  );
  await expect(level).toHaveValue("");
  await form.getByLabel("Meal", { exact: true }).selectOption("lunch");
  await form.getByRole("radio", { name: "Half" }).check();
  await form.getByRole("button", { name: "Save entry" }).click();
  await expect(level).toHaveAttribute("aria-invalid", "true");
  await level.selectOption("6");
  const reason = form.getByLabel("Reason for giving a different level");
  await expect(reason).toBeVisible();
  await form.getByRole("button", { name: "Save entry" }).click();
  const refusal = form.getByRole("alert");
  await expect(refusal).toContainText(
    "This is not the prescribed level and may not be safe. Give the reason it was given, or choose the prescribed level.",
  );
  await expect(reason).toHaveAttribute("aria-invalid", "true");
  await expect(level).toHaveAttribute("aria-invalid", "true");
  await expectAccessible(page, "IDDSI refusal");

  await reason.fill("Soft diet trial agreed by the dietitian today");
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
  await expectHeader(page, "Dev Fixture", "Peanut");
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
    "The side chosen in words is not the side of the area marked on the drawing.",
  );
  // The refusal is at both the side question and the body area list.
  await expect(form.getByRole("radio", { name: "Right", exact: true })).toHaveAttribute(
    "aria-invalid",
    "true",
  );
  await expect(area).toHaveAttribute("aria-invalid", "true");
  await expectAccessible(page, "body map refusal");

  // The list is the same as the drawing for keyboard and screen reader users.
  await area.selectOption("knee:right");
  await expect(form.getByText("Marked on the drawing: Knee, the person's right")).toBeVisible();
  await form.getByRole("button", { name: "Save mark" }).click();
  await expect(form.getByRole("status").filter({ hasText: "Mark saved" })).toBeVisible();
  const row = page
    .getByRole("table", { name: /Marks on Dev's skin/ })
    .getByRole("rowheader", { name: "Knee, person's right, front" })
    .first();
  await expect(row).toBeVisible();
});

test("keyboard only: move between tabs and record a body map mark with the area list and the side in words", async ({
  page,
}) => {
  await page.goto(`/people/${demoPerson(4)}`);
  const tabs = page.getByRole("navigation", { name: "Sections of Dev's record" });
  await tabTo(page, tabs.getByRole("link", { name: "Body map", exact: true }));
  await page.keyboard.press("Enter");
  await page.waitForURL(/\/body-map$/);
  await expect(page).toHaveTitle(`Body map | ${PEOPLE} | Harbour`);

  const form = page.getByRole("region", { name: "Record a mark" });
  const area = form.getByLabel("Body area, as marked on the drawing");
  await tabTo(page, area);
  await page.keyboard.type("Knee, the person's r");
  await expect(area).toHaveValue("knee:right");
  const left = form.getByRole("radio", { name: "Left", exact: true });
  await tabTo(page, left);
  await page.keyboard.press("ArrowRight");
  await expect(form.getByRole("radio", { name: "Right", exact: true })).toBeChecked();
  const markType = form.getByLabel("Type of mark");
  await tabTo(page, markType);
  await page.keyboard.type("Rash");
  await expect(markType).toHaveValue("rash");
  await tabTo(page, form.getByRole("button", { name: "Save mark" }));
  await page.keyboard.press("Enter");
  const saved = form.getByText("Mark saved. Any follow-up tasks will appear on the task list.", {
    exact: true,
  });
  await expect(saved).toBeVisible();
  await expect(saved).toBeFocused();
  await expectAccessible(page, "body map by keyboard");
});

test("hazard HZ-012 a nurse runs MUST and sees the API's score, band, workings, follow-ups and source", async ({
  page,
}) => {
  await page.goto(`/people/${demoPerson(6)}/assessments`);
  await expectHeader(page, "Frank Dummy");
  await expectAccessible(page, "assessments");
  await page.getByRole("link", { name: "Run MUST" }).click();
  await page.waitForURL(/\?run=must$/);
  await expect(page).toHaveTitle(`Run MUST | Assessments | ${PEOPLE} | Harbour`);

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
  await expect(
    result.getByRole("heading", { name: "Malnutrition Universal Screening Tool (MUST)" }),
  ).toBeFocused();
  await expect(result.getByText("Score 3", { exact: true })).toBeVisible();
  await expect(result.getByText("High risk", { exact: true })).toBeVisible();
  // Each step's points as the API worked them out.
  const workings = result.getByRole("table", { name: "How the result was worked out" });
  for (const [step, points] of [
    ["Step 1: BMI score", "2"],
    ["Step 2: weight loss score", "1"],
    ["Step 3: acute disease effect score", "0"],
  ] as const) {
    const row = workings
      .getByRole("row")
      .filter({ has: page.getByRole("rowheader", { name: step }) });
    await expect(row.getByRole("cell").last(), step).toHaveText(points);
  }
  await expect(result.getByText(/^Task: MUST high risk: refer to dietitian/)).toBeVisible();
  await expect(result.getByText(/^Next due \d{2}\/\d{2}\/\d{4}$/)).toBeVisible();
  // The publisher, edition and source the API calculates from.
  await expect(
    result.getByRole("link", {
      name: "Source: BAPEN, Malnutrition Universal Screening Tool (MUST), 2003, reviewed August 2011",
    }),
  ).toHaveAttribute("href", "https://www.bapen.org.uk/must-and-self-screening/must-calculator");
  // No escalation policy is linked for MUST in the demo: the result says so, never nothing
  // (HZ-012; #26 review round 2, C6).
  await expect(
    result.getByText(
      "No escalation policy is configured for this result. Follow your organisation's procedures and tell the nurse in charge.",
    ),
  ).toBeVisible();
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
  // The required words are checked first, each at its field.
  await form.getByRole("button", { name: "Save risk assessment" }).click();
  await expect(form.getByLabel("What is the hazard?")).toHaveAttribute("aria-invalid", "true");
  await expect(form.getByLabel("Who is at risk?")).toHaveAttribute("aria-invalid", "true");
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
  const arrived = page.locator("[data-arrival-notice]");
  await expect(arrived).toHaveText("Risk assessment saved");
  await expect(arrived).toBeFocused();
  const saved = page
    .getByRole("article")
    .filter({ hasText: "Ben wants to walk to the newsagent on his own." })
    .first();
  await expect(saved.getByText("Rating 9: high risk")).toBeVisible();
  await expect(saved.getByText("After the controls, rating 6: moderate risk")).toBeVisible();
  // Closing names the assessment and what closing it changes; Cancel gives focus back.
  const close = saved.getByRole("button", { name: "Close this risk assessment: Going out alone" });
  await close.click();
  await expect(
    saved.getByText(/^Once closed, it is no longer in use or due for review/),
  ).toBeVisible();
  await expect(saved.getByLabel("Why it no longer applies")).toBeFocused();
  await saved.getByRole("button", { name: "Cancel" }).click();
  await expect(close).toBeFocused();
  await expectAccessible(page, "risk assessments");
});

test("a nurse writes a note and corrects it with a reason", async ({ page }) => {
  await page.goto(`/people/${demoPerson(1)}/notes`);
  await expectHeader(page, "Addie");
  await expectAccessible(page, "notes");

  const text = `Addie enjoyed the garden walk and drank a cup of tea (${Date.now()}).`;
  const form = page.getByRole("region", { name: "Write a note" });
  // The time says Now until it is changed; Earlier opens the date and time boxes.
  await expect(form.getByRole("radio", { name: /^Now/ })).toBeChecked();
  await form.getByRole("radio", { name: /^Earlier/ }).check();
  const when = form.getByRole("group", { name: "Date and time it happened" });
  await expect(when.getByRole("textbox", { name: "Hour" })).not.toHaveValue("");
  await form.getByRole("radio", { name: /^Now/ }).check();
  await form.getByLabel("What is it about?").selectOption("activity");
  await form.getByRole("button", { name: "Save note" }).click();
  await expect(form.getByLabel("Note", { exact: true })).toHaveAttribute("aria-invalid", "true");
  await form.getByLabel("Note", { exact: true }).fill(text);
  await form.getByRole("button", { name: "Save note" }).click();
  await expect(form.getByRole("status")).toHaveText("Note saved");

  const list = page.getByRole("list", { name: "Notes about Addie" });
  const entry = list.getByRole("listitem").filter({ hasText: text });
  await expect(entry).toHaveCount(1);
  await expect(entry.getByText("Activity")).toBeVisible();
  await expectAccessible(page, "note saved");

  const correct = entry.getByRole("button", { name: "Correct this note" });
  await correct.click();
  await expect(entry.getByLabel("Corrected note")).toBeFocused();
  await entry.getByRole("button", { name: "Cancel" }).click();
  await expect(correct).toBeFocused();
  await correct.click();
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
  await expect(chain.getByRole("button", { name: "Correct this note" })).toBeFocused();
  await expectAccessible(page, "corrected note");
});

test("the record reflows at 320 px: the header and tabs fit and only the tab row scrolls", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 900 });
  await page.goto(`/people/${demoPerson(4)}`);
  // On a phone the shell's sidebar folds to its icons; wait for it before measuring.
  await page.locator('[data-collapsed="true"]').waitFor();
  await settleAnimations(page);
  const header = await expectHeader(page, "Dev Fixture", "Peanut");
  await expect(header.locator("[data-resuscitation]")).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, "the page scrolls sideways").toBeLessThanOrEqual(0);
  const list = page
    .getByRole("navigation", { name: "Sections of Dev's record" })
    .locator(".hb-tabnav__list");
  const sizes = await list.evaluate((element) => ({
    scroll: element.scrollWidth,
    client: element.clientWidth,
  }));
  expect(sizes.scroll, "the tabs scroll within their row").toBeGreaterThan(sizes.client);
  await expectAccessible(page, "overview at 320 px");
});
