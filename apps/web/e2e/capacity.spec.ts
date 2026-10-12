import { type APIRequestContext, expect, test } from "@playwright/test";
import { demoPerson, expectAccessible, signIn } from "./support";

/**
 * Phase 1 slice 9: the consent, capacity and DoLS tab (register rows CARE-021 and CARE-022;
 * hazards HZ-020 and HZ-026) against the demo tenant. The tab reads these records; the forms that
 * record them come later, so the journey records them through the API as the demo nurse and then
 * reads them on the tab. Each run adds its own records to Else (resident 5), marked with the run,
 * and changes nothing already there.
 */

const API_URL = process.env.API_URL ?? "http://localhost:4000";
const DEMO_TENANT = "0194d000-0000-7000-8000-000000000001";
const PERSON = demoPerson(5);
const RUN = `run ${Date.now().toString(36)}`;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

async function record(request: APIRequestContext, path: string, data: object) {
  const response = await request.post(`${API_URL}/v1/people/${PERSON}/${path}`, {
    headers: { "x-harbour-tenant": DEMO_TENANT },
    data,
  });
  expect(response.status(), `${path} ${await response.text()}`).toBe(201);
}

test("hazard HZ-020 hazard HZ-026 the tab shows consent by decision and the DoLS clock in words", async ({
  page,
}) => {
  await signIn(page, "nurse@example.invalid");
  const now = Date.now();
  const at = (offset: number) => new Date(now + offset).toISOString();
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
  const dols = page
    .getByRole("region", { name: "DoLS register" })
    .getByRole("article")
    .filter({ hasText: RUN });
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
