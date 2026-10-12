import {
  type APIRequestContext,
  type BrowserContext,
  expect,
  type Locator,
  type Page,
  test,
} from "@playwright/test";
import { demoPerson, expectAccessible, signIn } from "./support";

/**
 * Phase 1 slice 9: the consent, capacity and DoLS tab (register rows CARE-021 and CARE-022;
 * hazards HZ-020 and HZ-026) against the demo tenant. The tab reads these records; the forms that
 * record them come later, so the journeys record them through the API as the demo nurse and then
 * read them on the tab, every warning state included. Each run adds its own records to Else
 * (resident 5), marked with the run, and changes nothing already there. Ben (resident 2) has none.
 */

const API_URL = process.env.API_URL ?? "http://localhost:4000";
const DEMO_TENANT = "0194d000-0000-7000-8000-000000000001";
const PERSON = demoPerson(5);
const EMPTY = demoPerson(2);
const RUN = `run ${Date.now().toString(36)}`;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

test.describe.configure({ mode: "serial" });

// Sign in once (Better Auth throttles sign-ins) and give every journey the same session.
let session: Awaited<ReturnType<BrowserContext["cookies"]>> = [];

test.beforeAll(async ({ browser }, testInfo) => {
  const context = await browser.newContext({ baseURL: testInfo.project.use.baseURL });
  const page = await context.newPage();
  await signIn(page, "nurse@example.invalid");
  session = await context.cookies();
  await context.close();
});

test.beforeEach(async ({ context }) => {
  await context.addCookies(session);
});

async function record(request: APIRequestContext, path: string, data: object) {
  const response = await request.post(`${API_URL}/v1/people/${PERSON}/${path}`, {
    headers: { "x-harbour-tenant": DEMO_TENANT },
    data,
  });
  expect(response.status(), `${path} ${await response.text()}`).toBe(201);
  return (await response.json()) as { id: string };
}

const at = (offset: number) => new Date(Date.now() + offset).toISOString();

/** A two-stage assessment that finds a lack of capacity for bed rails at night. */
const assessed = {
  decision: `Whether to use bed rails at night (${RUN})`,
  decisionKind: "bed_rails",
  assessorName: "Nell Nurse",
  assessorRole: "Clinical lead",
  practicableSteps: [{ step: "visual_aids", detail: "Showed photographs of the bed and rails." }],
  stage1: { impairment: true, description: "Dementia, diagnosed by the memory clinic." },
  stage2: {
    understand: { able: false, evidence: "Could not say what the rails are for." },
    retain: { able: true },
    useOrWeigh: { able: false, evidence: "Could not weigh the risk of falling." },
    communicate: { able: true },
  },
  inabilityBecauseOfImpairment: true,
  outcome: "lacks_capacity",
  reviewOn: at(90 * DAY).slice(0, 10),
};

/** The record of this run in one part of the tab. */
const article = (page: Page, part: string, text = RUN) =>
  page.getByRole("region", { name: part }).getByRole("article").filter({ hasText: text });

/** Presses Tab until the target has focus: the keyboard is the only way in. */
async function tabTo(page: Page, target: Locator, limit = 300) {
  for (let presses = 0; presses < limit; presses += 1) {
    if (await target.evaluate((element) => element === document.activeElement)) return;
    await page.keyboard.press("Tab");
  }
  throw new Error("The target could not be reached with the Tab key");
}

/** An authorisation recorded in this run, found by its supervisory body reference. */
const authorisation = (page: Page, reference: string) =>
  page
    .getByRole("region", { name: "DoLS register" })
    .getByRole("article")
    .filter({ hasText: `${RUN} ${reference}` });

/** A standard authorisation granted for the given days either side of now. */
const granted = (reference: string, from: number, to: number, extra: object = {}) => ({
  type: "standard",
  requestedAt: at((Math.min(from, 0) - 5) * DAY),
  outcome: "granted",
  outcomeAt: at(Math.min(from, 0) * DAY - HOUR),
  grantedFrom: at(from * DAY),
  grantedTo: at(to * DAY),
  supervisoryBody: "Example County Council",
  supervisoryBodyReference: `${RUN} ${reference}`,
  ...extra,
});

test("hazard HZ-020 hazard HZ-026 the tab shows consent by decision and the DoLS register, every warning state in words", async ({
  page,
}) => {
  // Consent: in place for the care plan, expired for photographs, refused for social media.
  await record(page.request, "capacity-assessments", {
    decision: `Whether to use bed rails at night (${RUN})`,
    decisionKind: "bed_rails",
    assessedAt: at(-3 * HOUR),
    assessorName: "Nell Nurse",
    assessorRole: "Clinical lead",
    practicableSteps: [{ step: "visual_aids", detail: "Showed photographs of the bed and rails." }],
    stage1: { impairment: true, description: "Dementia, diagnosed by the memory clinic." },
    stage2: {
      understand: { able: false, evidence: "Could not say what the rails are for." },
      retain: { able: true },
      useOrWeigh: { able: false, evidence: "Could not weigh the risk of falling." },
      communicate: { able: true },
    },
    inabilityBecauseOfImpairment: true,
    outcome: "lacks_capacity",
    reviewOn: at(90 * DAY).slice(0, 10),
  });
  // A finding about sharing whose review date has passed.
  await record(page.request, "capacity-assessments", {
    decision: `Whether to share her care plan with her family (${RUN})`,
    decisionKind: "sharing",
    assessedAt: at(-2 * HOUR),
    assessorName: "Nell Nurse",
    stage1: { impairment: false },
    outcome: "has_capacity",
    reviewOn: at(-DAY).slice(0, 10),
  });
  await record(page.request, "consents", {
    decision: "care_plan",
    outcome: "given",
    givenBy: "person",
    givenAt: at(-HOUR),
    evidence: `Talked the plan through with Else (${RUN}).`,
  });
  await record(page.request, "consents", {
    decision: "photos",
    outcome: "given",
    givenBy: "person",
    givenAt: at(-3 * HOUR),
    expiresAt: at(-HOUR),
    evidence: `Agreed to photographs for one afternoon (${RUN}).`,
  });
  await record(page.request, "consents", {
    decision: "social_media",
    outcome: "refused",
    givenBy: "person",
    givenAt: at(-HOUR),
    evidence: `Said no to photographs online (${RUN}).`,
  });

  // DoLS: one of each state the register shows.
  await record(page.request, "dols", {
    type: "urgent",
    requestedAt: at(-2 * HOUR),
    outcome: "granted",
    outcomeAt: at(-2 * HOUR),
    grantedFrom: at(-2 * HOUR),
    grantedTo: at(6 * DAY - 2 * HOUR),
    supervisoryBodyReference: `${RUN} urgent`,
  });
  await record(page.request, "dols", {
    type: "urgent",
    requestedAt: at(-8 * DAY),
    outcome: "granted",
    outcomeAt: at(-8 * DAY),
    grantedFrom: at(-8 * DAY),
    // An hour inside the 7 days, whichever way the clocks change in between.
    grantedTo: at(-DAY - HOUR),
    extensions: [{ requestedAt: at(-2 * DAY), outcome: "granted", extendedTo: at(5 * DAY) }],
    supervisoryBodyReference: `${RUN} extended`,
  });
  await record(page.request, "dols", {
    type: "standard",
    requestedAt: at(-DAY),
    supervisoryBodyReference: `${RUN} pending`,
  });
  await record(page.request, "dols", {
    type: "standard",
    requestedAt: at(-10 * DAY),
    outcome: "not_granted",
    outcomeAt: at(-5 * DAY),
    supervisoryBodyReference: `${RUN} not granted`,
  });
  await record(page.request, "dols", granted("starts later", 3, 200));
  await record(page.request, "dols", granted("expired", -60, -30));
  const renewed = await record(page.request, "dols", granted("renewed", -45, -2));
  await record(
    page.request,
    "dols",
    granted("renewal", -2, 300, { precededByAuthorisationId: renewed.id }),
  );
  // Granted before the June 2026 judgment and still in force: its review has not started.
  const beforeJudgment = {
    type: "standard",
    requestedAt: "2026-05-20T09:00:00Z",
    outcome: "granted",
    outcomeAt: "2026-06-01T09:00:00Z",
    grantedFrom: "2026-06-01T09:00:00Z",
    grantedTo: "2027-05-31T09:00:00Z",
    supervisoryBodyReference: `${RUN} before the judgment`,
  };
  const legalChangeStillOpen = Date.now() < Date.parse(beforeJudgment.grantedTo) - DAY;
  if (legalChangeStillOpen) await record(page.request, "dols", beforeJudgment);

  // The link in the DoLS expiry alerts opens the register.
  await page.goto(`/people/${PERSON}/dols`);
  await page.waitForURL(/\/capacity$/);
  await expect(page).toHaveTitle("Consent, capacity and DoLS | Residents | Harbour");
  await expect(
    page.getByRole("heading", { level: 2, name: "Consent, capacity and DoLS" }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("region", { name: "Person details" })
      .getByText("Resuscitation", { exact: true }),
  ).toBeVisible();

  // Whether a valid consent is in place for each decision now, in words and an icon (HZ-026).
  const decisions = page.getByRole("region", { name: "Consent by decision" });
  const row = (decision: string) => decisions.locator(`[data-consent-decision="${decision}"]`);
  await expect(row("care_plan").getByText("Consent in place")).toBeVisible();
  await expect(row("care_plan").locator(".hb-status-chip svg")).toBeVisible();
  await expect(row("photos").getByText("No valid consent")).toBeVisible();
  await expect(row("photos").getByText("Consent has expired. Ask again.")).toBeVisible();
  await expect(row("social_media").getByText("Refused", { exact: true })).toBeVisible();
  await expect(
    row("social_media").getByText("Else refused consent for this decision."),
  ).toBeVisible();
  await expect(row("marketing").getByText("No consent recorded")).toBeVisible();
  await expect(
    row("marketing").getByText("Record a consent or refusal before acting on this decision."),
  ).toBeVisible();
  await expect(
    row("bed_rails").getByText(/^Assessed on \d{2}\/\d{2}\/\d{4} as lacking capacity/),
  ).toBeVisible();
  await expect(row("bed_rails").getByText(/^Review by \d{2}\/\d{2}\/\d{4}$/)).toBeVisible();
  await expect(row("sharing").getByText("Capacity review overdue")).toBeVisible();

  // Each authorisation's status and clock, in words and UK dates (HZ-020).
  const urgent = authorisation(page, "urgent");
  await expect(urgent.getByRole("heading", { name: /^Urgent authorisation of / })).toBeVisible();
  await expect(urgent.getByText("Ending soon")).toBeVisible();
  await expect(urgent.locator(".hb-status-chip svg").first()).toBeVisible();
  await expect(urgent.locator("time").first()).toHaveAttribute("datetime", /^\d{4}-\d{2}-\d{2}T/);
  await expect(
    urgent.getByText(/^(Ends|In force until the end of) \d{2}\/\d{2}\/\d{4}/),
  ).toBeVisible();
  await expect(urgent.getByText(/^\d+ days until the last day in force$/)).toBeVisible();
  await expect(urgent.getByText(/^Expiry reminder to the Registered Manager: /)).toBeVisible();
  await expect(
    urgent.getByText(/urgent authorisation is not notified to CQC on its own/),
  ).toBeVisible();
  await expect(
    authorisation(page, "extended").getByText(/^Extension requested .*: granted until /),
  ).toBeVisible();
  await expect(authorisation(page, "pending").getByText("Awaiting the outcome")).toBeVisible();
  await expect(
    authorisation(page, "not granted").getByText("Not granted", { exact: true }),
  ).toBeVisible();
  await expect(authorisation(page, "starts later").getByText("Not yet in force")).toBeVisible();
  await expect(authorisation(page, "expired").getByText("Expired", { exact: true })).toBeVisible();
  await expect(authorisation(page, "renewed").getByText("Renewed", { exact: true })).toBeVisible();
  await expect(authorisation(page, "renewed").getByText("Expired", { exact: true })).toHaveCount(0);
  if (legalChangeStillOpen) {
    const before = authorisation(page, "before the judgment");
    await expect(before.getByText("Review after the legal change: not started")).toBeVisible();
    await expect(
      before.getByText(/review this authorisation as soon as practicable/),
    ).toBeVisible();
  }

  await expectAccessible(page, "consent, capacity and DoLS tab");
  await page.emulateMedia({ colorScheme: "dark" });
  await expectAccessible(page, "consent, capacity and DoLS tab, dark theme");
  await page.emulateMedia({ colorScheme: "light" });

  // By keyboard to the first authorisation's history, with the focus ring showing.
  const history = page
    .getByRole("region", { name: "DoLS register" })
    .getByRole("link", { name: /^View the changes to the / })
    .first();
  await tabTo(page, history);
  expect(await history.evaluate((link) => link.matches(":focus-visible"))).toBe(true);
  expect(await history.evaluate((link) => getComputedStyle(link).outlineStyle)).not.toBe("none");
  const box = await history.boundingBox();
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("heading", { level: 2, name: "Changes to the DoLS authorisation" }),
  ).toBeVisible();
  await expectAccessible(page, "DoLS authorisation history");
});

test("the tab reflows at 320 px and says when nothing is recorded", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 900 });
  await page.goto(`/people/${PERSON}/capacity`);
  await page.locator('[data-collapsed="true"]').waitFor();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, "the page scrolls sideways").toBeLessThanOrEqual(0);
  await expectAccessible(page, "consent, capacity and DoLS tab at 320 px");

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/people/${EMPTY}/capacity`);
  await expect(page.getByText("No DoLS requests or authorisations.")).toBeVisible();
  await expect(
    page.locator('[data-consent-decision="bed_rails"]').getByText("No consent recorded"),
  ).toBeVisible();
  await expectAccessible(page, "consent, capacity and DoLS tab with nothing recorded");
});

test("hazard HZ-026 the tab shows the two-stage test, the best-interests checklist and each consent record, with corrections", async ({
  page,
}) => {
  // Its own decision words, apart from the first journey's assessment of the same decision.
  const decision = `Whether to use bed rails at night (${RUN}, corrected)`;
  const original = await record(page.request, "capacity-assessments", {
    ...assessed,
    decision,
    assessedAt: at(-3 * HOUR),
  });
  // A correction supersedes the assessment; both stay readable (care.md rule 4).
  await record(page.request, "capacity-assessments", {
    ...assessed,
    decision,
    assessedAt: at(-3 * HOUR),
    assessorRole: "Clinical lead (registered nurse)",
    supersedesId: original.id,
    correctionReason: "The assessor's role was incomplete.",
  });
  const considered = { answer: "considered", note: "Talked with the team and her family." };
  await record(page.request, "best-interests", {
    capacityAssessmentId: original.id,
    decision: `Move to a ground-floor room near the nurses' station (${RUN})`,
    decidedAt: at(-2 * HOUR),
    checklist: {
      no_unjustified_assumptions: considered,
      relevant_circumstances: considered,
      regaining_capacity: considered,
      participation: considered,
      life_sustaining_treatment: { answer: "not_applicable", reason: "Not about treatment." },
      wishes_and_feelings: considered,
      beliefs_and_values: considered,
      other_factors: considered,
      views_of_others: considered,
      less_restrictive_option: considered,
    },
    consultations: [
      {
        consultee: "paid_carer_or_professional",
        name: "Cat Carer",
        views: "Settles better near the station.",
        consultedAt: at(-3 * HOUR),
      },
    ],
    accommodationChange: true,
    reviewOn: assessed.reviewOn,
  });

  await page.goto(`/people/${PERSON}/capacity`);

  // The two-stage test as recorded, the outcome in the Act's words, and the correction.
  const capacity = article(page, "Capacity assessments", decision);
  await expect(
    capacity.getByText("Lacks capacity for this decision", { exact: true }),
  ).toBeVisible();
  await expect(
    capacity.getByText(/^Assessed .* by Nell Nurse, Clinical lead \(registered nurse\)$/),
  ).toBeVisible();
  await expect(
    capacity.getByText("Understand the information relevant to the decision", { exact: true }),
  ).toBeVisible();
  await expect(capacity.getByText(/^Not able/).first()).toBeVisible();
  await expect(
    capacity.getByText(
      "This corrects an earlier version. Reason: The assessor's role was incomplete.",
    ),
  ).toBeVisible();
  await capacity.getByText("Show the earlier version").click();
  await expect(capacity.locator("del")).toHaveText(/^Whether to use bed rails at night/);

  // A change of accommodation with only paid carers consulted: the IMCA prompt (MCA s.38, s.39).
  const bestInterests = article(page, "Best-interests decisions");
  await expect(
    bestInterests.getByText("Independent Mental Capacity Advocate (IMCA)"),
  ).toBeVisible();
  await bestInterests.getByText("Section 4 checklist: 10 of 10 items answered").click();
  await expect(
    bestInterests.getByText("A less restrictive way to achieve the purpose (s.1(6))"),
  ).toBeVisible();

  // The consent the first journey recorded, as the record deciding the care plan consent.
  const consent = article(page, "Consent records");
  await expect(consent.getByText("In force", { exact: true })).toBeVisible();
  await expect(consent.getByText(/^Consent given .* by Else$/)).toBeVisible();
  await expect(consent.getByText("Recorded by Nell Nurse", { exact: false })).toBeVisible();

  await expectAccessible(page, "consent, capacity and DoLS records");
  await page.emulateMedia({ colorScheme: "dark" });
  await expectAccessible(page, "consent, capacity and DoLS records, dark theme");
  await page.emulateMedia({ colorScheme: "light" });

  await consent.getByRole("link", { name: "View the changes to this record" }).click();
  await expect(
    page.getByRole("heading", { level: 2, name: "Changes to the consent record" }),
  ).toBeVisible();
});
