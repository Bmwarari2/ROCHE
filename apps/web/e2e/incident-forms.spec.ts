import { type APIRequestContext, expect, test } from "@playwright/test";
import { demoPerson, expectAccessible, signIn } from "./support";

/**
 * Phase 1 slice 9: recording an incident and answering the classifier's questions (register rows
 * SAFE-001 and SAFE-002; hazards HZ-013 and HZ-027) against the demo tenant. The carer records a
 * fall from a resident's record, answering the falls questions there; the nurse, who manages
 * incidents, answers one of the questions that follow on the incident's page. Each run adds its
 * own incident, marked with the run in its narrative, and changes nothing already there. A third
 * journey answers on a page whose incident was closed meanwhile, and is refused in words.
 */

const RUN = `run ${Date.now().toString(36)}`;
const PERSON = demoPerson(3);
const API_URL = process.env.API_URL ?? "http://localhost:4000";
const DEMO_TENANT = "0194d000-0000-7000-8000-000000000001";
const DEMO_LOCATION = "0194d000-0000-7000-8000-000000000101";

interface Incident {
  readonly id: string;
  readonly version: number;
  readonly classifier: { readonly openQuestions: readonly { key: string; kind: string }[] } | null;
}

async function call<T = Incident>(
  request: APIRequestContext,
  path: string,
  data?: object,
  status = data ? 201 : 200,
): Promise<T> {
  const options = { headers: { "x-harbour-tenant": DEMO_TENANT }, ...(data ? { data } : {}) };
  const response = await (data ? request.post : request.get).call(
    request,
    `${API_URL}${path}`,
    options,
  );
  expect(response.status(), `${path} ${await response.text()}`).toBe(status);
  return (await response.json()) as T;
}

/** Answers every open question "no" (or none, or 0), as a manager would before closing. */
async function answerEverything(request: APIRequestContext, id: string) {
  for (let round = 0; round < 6; round += 1) {
    const open = (await call(request, `/v1/incidents/${id}`)).classifier?.openQuestions ?? [];
    if (open.length === 0) return;
    const value = (kind: string) =>
      kind === "yes_no_unsure"
        ? "no"
        : kind === "days" || kind === "hours"
          ? 0
          : kind === "choice"
            ? "none"
            : ["none"];
    const answers = open.map((q) => ({ key: q.key, value: value(q.kind) }));
    await call(request, `/v1/incidents/${id}/classifier`, { answers }, 200);
  }
  throw new Error("The questions kept coming");
}

test.describe.configure({ mode: "serial" });

let incidentPath = "";

test("hazard HZ-027 the carer records a fall from a resident's record, never assumed no", async ({
  page,
}) => {
  await signIn(page, "carer@example.invalid");
  await page.goto(`/people/${PERSON}`);
  await page.getByRole("link", { name: "Record an incident" }).click();
  await page.waitForURL((url) => url.pathname === "/incidents/new");
  await expect(page.getByRole("heading", { level: 1, name: "Record an incident" })).toBeVisible();
  // The person's communication needs beside their name, labelled in every state (AIS).
  const about = page.getByRole("group", { name: /^About / });
  await expect(about.getByRole("term")).toHaveText("Communication needs");
  await expect(about.getByRole("definition")).toContainText("Uses a hearing loop");
  await expectAccessible(page, "record an incident, empty");

  await page.getByLabel("What kind of incident was it?").selectOption("fall");
  await page
    .getByLabel("What happened", { exact: true })
    .fill(`Found on the floor beside their bed (${RUN}).`);
  // Nothing about who was called, nor the falls questions: the form asks rather than assume no.
  await page.getByRole("button", { name: "Record the incident" }).click();
  // In main: Next.js's route announcer is an empty alert outside it.
  const summary = page.getByRole("main").getByRole("alert");
  await expect(summary).toBeFocused();
  for (const words of [
    "Say when it happened: just now, or earlier with the date and time",
    "Say whether the emergency services were called",
    "Say whether the GP was contacted",
    "Say whether the person died",
  ]) {
    await expect(summary.getByRole("link", { name: words })).toBeVisible();
  }
  await expect(
    summary.getByRole("link", {
      name: "Answer this question. If you do not know, choose not sure yet",
    }),
  ).toBeVisible();
  await expectAccessible(page, "record an incident, with errors");

  // The summary's link takes focus to the question it is about.
  await summary.getByRole("link", { name: "Say whether the GP was contacted" }).click();
  await expect(
    page.getByRole("group", { name: "Was the GP contacted?" }).getByRole("radio", { name: "Yes" }),
  ).toBeFocused();

  const answer = (question: string, choice: string) =>
    page.getByRole("group", { name: question }).getByRole("radio", { name: choice, exact: true });
  await answer("When did it happen?", "Just now").check();
  await answer("Was the GP contacted?", "Yes").check();
  await answer("Were the emergency services called?", "No").check();
  await answer("Did the person die?", "No").check();
  await answer(
    "Did the person hit their head, or can a head injury not be ruled out (for example, nobody saw the fall)?",
    "Not sure yet",
  ).check();
  await answer(
    "Is the person currently having anticoagulant or antiplatelet treatment (except aspirin on its own)?",
    "No",
  ).check();
  await page.getByRole("button", { name: "Record the incident" }).click();

  await page.waitForURL((url) => /^\/incidents\/[0-9a-f-]{36}$/.test(url.pathname));
  incidentPath = new URL(page.url()).pathname;
  // The page says it was recorded and starts at its heading.
  await expect(page.getByRole("status").getByText("Incident recorded")).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toBeFocused();
  await expect(page.getByText(`Found on the floor beside their bed (${RUN}).`)).toBeVisible();
  await expectAccessible(page, "the recorded incident");
});

test("hazard HZ-013 the nurse answers a question on the incident's page", async ({ page }) => {
  test.skip(!incidentPath, "The incident was not recorded");
  await signIn(page, "nurse@example.invalid");
  await page.goto(incidentPath);
  const form = page.getByRole("form", {
    name: "Answer the questions about statutory notifications",
  });
  await expect(form).toBeVisible();
  await expect(page.getByText("Answer them below.")).toBeVisible();
  await expectAccessible(page, "the questions, empty");

  await form.getByRole("button", { name: "Save answers" }).click();
  await expect(page.getByRole("alert").getByText("Answer at least one question")).toBeVisible();
  await expectAccessible(page, "the questions, with an error");

  // Not sure yet is always an answer: the first question's.
  await form.getByLabel("Not sure yet").first().check();
  await form.getByRole("button", { name: "Save answers" }).click();
  await expect(
    page
      .getByRole("status")
      .getByText("Answers saved. Harbour has checked again which notifications are needed."),
  ).toBeVisible();
  await expectAccessible(page, "the questions, saved");
});

test("hazard HZ-013 answering on an incident closed meanwhile is refused in words", async ({
  page,
  browser,
}, testInfo) => {
  // The carer raises it (the person who raised an incident cannot close it).
  const carer = await browser.newContext({ baseURL: testInfo.project.use.baseURL });
  const carerPage = await carer.newPage();
  await signIn(carerPage, "carer@example.invalid");
  const incident = await call(carerPage.request, "/v1/incidents", {
    locationId: DEMO_LOCATION,
    occurredAt: new Date(Date.now() - 60 * 60_000).toISOString(),
    type: "environmental",
    description: `A radiator leaked in the corridor (${RUN}).`,
    emergencyServicesCalled: false,
    gpContacted: false,
  });
  await carer.close();

  await signIn(page, "nurse@example.invalid");
  await page.goto(`/incidents/${incident.id}`);
  const form = page.getByRole("form", {
    name: "Answer the questions about statutory notifications",
  });
  await expect(form).toBeVisible();
  // Meanwhile, elsewhere, every question is answered and the incident closed.
  await answerEverything(page.request, incident.id);
  const answered = await call(page.request, `/v1/incidents/${incident.id}`);
  await call(
    page.request,
    `/v1/incidents/${incident.id}/close`,
    { reason: "The radiator was repaired.", version: answered.version },
    200,
  );

  await form.getByLabel("Not sure yet").first().check();
  await form.getByRole("button", { name: "Save answers" }).click();
  const alert = page.getByRole("main").getByRole("alert");
  await expect(alert).toBeFocused();
  await expect(alert).toContainText("This incident is closed, so it cannot be changed.");
  await expectAccessible(page, "the questions, refused on a closed incident");
});
