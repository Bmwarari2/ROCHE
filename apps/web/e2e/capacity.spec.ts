import {
  type APIRequestContext,
  type BrowserContext,
  expect,
  type Page,
  test,
} from "@playwright/test";
import { demoPerson, expectAccessible, signIn } from "./support";

/**
 * Phase 1 slice 9: the consent, capacity and DoLS tab (register rows CARE-021 and CARE-022;
 * hazards HZ-020 and HZ-026) against the demo tenant. The tab reads these records; the forms that
 * record them come later, so the journeys record them through the API as the demo nurse and then
 * read them on the tab. Each run adds its own records to Else (resident 5), marked with the run,
 * and changes nothing already there.
 */

const API_URL = process.env.API_URL ?? "http://localhost:4000";
const DEMO_TENANT = "0194d000-0000-7000-8000-000000000001";
const PERSON = demoPerson(5);
const RUN = `run ${Date.now().toString(36)}`;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

test.describe.configure({ mode: "serial" });

// Sign in once (Better Auth throttles sign-ins) and give both journeys the same session.
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

test("hazard HZ-020 hazard HZ-026 the tab shows consent by decision and the DoLS clock in words", async ({
  page,
}) => {
  await record(page.request, "capacity-assessments", { ...assessed, assessedAt: at(-3 * HOUR) });
  await record(page.request, "consents", {
    decision: "care_plan",
    outcome: "given",
    givenBy: "person",
    givenAt: at(-HOUR),
    evidence: `Talked the plan through with Else (${RUN}).`,
  });
  await record(page.request, "dols", {
    type: "urgent",
    requestedAt: at(-2 * HOUR),
    outcome: "granted",
    outcomeAt: at(-2 * HOUR),
    grantedFrom: at(-2 * HOUR),
    grantedTo: at(6 * DAY - 2 * HOUR),
    supervisoryBody: "Example County Council",
    supervisoryBodyReference: RUN,
  });

  await page.goto(`/people/${PERSON}/capacity`);
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
  const carePlan = decisions.locator('[data-consent-decision="care_plan"]');
  await expect(carePlan.getByText("Consent in place")).toBeVisible();
  await expect(carePlan.locator(".hb-status-chip svg")).toBeVisible();
  await expect(
    decisions.locator('[data-consent-decision="marketing"]').getByText("Not recorded"),
  ).toBeVisible();
  await expect(
    decisions
      .locator('[data-consent-decision="bed_rails"]')
      .getByText("Assessed as lacking capacity for this decision"),
  ).toBeVisible();

  // The urgent authorisation's clock, in words and UK dates (HZ-020).
  const dols = article(page, "DoLS register");
  await expect(dols.getByRole("heading", { name: "Urgent authorisation" })).toBeVisible();
  await expect(dols.getByText("Ending soon")).toBeVisible();
  await expect(dols.locator(".hb-status-chip svg")).toBeVisible();
  await expect(dols.getByText(/^Ends \d{2}\/\d{2}\/\d{4} \d{2}:\d{2}/)).toBeVisible();
  await expect(dols.getByText(/^[4-6] days left$/)).toBeVisible();
  await expect(dols.getByText(/^Expiry reminder to the Registered Manager: /)).toBeVisible();
  await expect(dols.getByText(/urgent authorisation is not notified on its own/)).toBeVisible();

  await expectAccessible(page, "consent, capacity and DoLS tab");
  await page.emulateMedia({ colorScheme: "dark" });
  await expectAccessible(page, "consent, capacity and DoLS tab, dark theme");
  await page.emulateMedia({ colorScheme: "light" });

  await dols.getByRole("link", { name: "View the changes to this record" }).click();
  await expect(
    page.getByRole("heading", { level: 2, name: "Changes to the DoLS authorisation" }),
  ).toBeVisible();
  await expectAccessible(page, "DoLS authorisation history");
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
