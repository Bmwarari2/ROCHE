import { type BrowserContext, expect, test } from "@playwright/test";
import { demoPerson, expectAccessible, signIn } from "./support";

/**
 * The history tab (`/people/[id]/history`) and one record's history page with what they hold: a
 * risk assessment recorded and then reviewed, so it has an earlier version. Closes the small gap in
 * docs/plans/phase-1-gate.md (the tab had axe only when empty, in care-record.spec.ts). The demo
 * nurse records and reviews the assessment through the API, marked with the run, for Cal (resident
 * 3); nothing already there changes.
 */

const API_URL = process.env.API_URL ?? "http://localhost:4000";
const DEMO_TENANT = "0194d000-0000-7000-8000-000000000001";
const PERSON = demoPerson(3);
const RUN = `run ${Date.now().toString(36)}`;
const HAZARD = `Choking at meals (${RUN})`;

test.describe.configure({ mode: "serial" });

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

test("the history tab lists a reviewed risk assessment and its earlier version passes axe in both themes", async ({
  page,
}) => {
  const request = page.request;
  const headers = { "x-harbour-tenant": DEMO_TENANT };
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Europe/London" });
  const assessment = {
    hazard: HAZARD,
    whoAtRisk: "The resident, at meals and snacks",
    answers: {
      salt_assessed: true,
      iddsi_food_recorded: true,
      iddsi_drink_recorded: true,
      signs_of_difficulty: false,
      needs_supervision: true,
    },
    likelihood: 2,
    severity: 3,
    residualLikelihood: 1,
    residualSeverity: 3,
    controls: ["Staff with them at meals and snacks"],
    assessedOn: today,
  };
  const created = await request.post(`${API_URL}/v1/people/${PERSON}/risk-assessments`, {
    headers,
    data: { templateKey: "choking", ...assessment },
  });
  expect(created.status(), await created.text()).toBe(201);
  const risk = (await created.json()) as { id: string; version: number };
  const reviewed = await request.put(`${API_URL}/v1/people/${PERSON}/risk-assessments/${risk.id}`, {
    headers,
    data: {
      ...assessment,
      controls: [...assessment.controls, "Staff trained in choking first aid"],
      version: risk.version,
    },
  });
  expect(reviewed.status(), await reviewed.text()).toBe(200);

  // The tab: the records with earlier versions, and the person's own details.
  await page.goto(`/people/${PERSON}/history`);
  await expect(page).toHaveTitle(/^History \| /);
  await expect(page.getByRole("heading", { level: 2, name: "History" })).toBeVisible();
  await expect(
    page.getByRole("heading", { level: 3, name: "Care records with earlier versions" }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { level: 3, name: "Personal details" })).toBeVisible();
  const link = page.getByRole("link", { name: `View the changes to ${HAZARD}` });
  await expect(link).toBeVisible();
  await expectAccessible(page, "history tab");
  await page.emulateMedia({ colorScheme: "dark" });
  await expectAccessible(page, "history tab, dark theme");
  await page.emulateMedia({ colorScheme: "light" });

  // One record's history: both versions, the change marked in words, and the way back.
  await link.click();
  await expect(page).toHaveURL(new RegExp(`/history/risk_assessment/${risk.id}$`));
  await expect(
    page.getByRole("heading", { level: 2, name: "Changes to the risk assessment" }),
  ).toBeVisible();
  const versions = page.getByRole("list", { name: "Changes to the risk assessment" });
  // Only earlier versions are listed: the first, with the controls as they were before the review.
  const first = versions.getByRole("listitem").filter({ hasText: "Version 1" });
  await expect(first).toHaveCount(1);
  await expect(versions.getByRole("listitem")).toHaveCount(1);
  await expect(first.getByText("Changed by you")).toBeVisible();
  // The review added a control, so the controls as they were are marked as changed since.
  const controls = first.getByRole("row", { name: /^Controls / });
  await expect(controls).toHaveText(/Staff with them at meals and snacks/);
  await expect(controls).toContainText("Changed in the next version");
  // Fields the review left alone are not marked.
  await expect(first.getByRole("row", { name: /^Hazard / })).not.toContainText(
    "Changed in the next version",
  );
  // Answers read as the template's questions in words, not stored data.
  const answers = first.getByRole("row", { name: /^Answers / });
  await expect(answers).toContainText("Does the person need someone with them when eating? Yes");
  await expect(answers).not.toContainText("{");
  await expect(first.getByRole("row", { name: /^Status / })).toHaveText(/In use/);
  await expectAccessible(page, "risk assessment history");
  await page.emulateMedia({ colorScheme: "dark" });
  await expectAccessible(page, "risk assessment history, dark theme");
  await page.emulateMedia({ colorScheme: "light" });

  await page.getByRole("link", { name: "Back to the history" }).click();
  await expect(page).toHaveURL(new RegExp(`/people/${PERSON}/history$`));
});
