import { expect, test } from "@playwright/test";
import { demoPerson, expectAccessible, signIn } from "./support";

/**
 * Phase 1 slice 9: recording an incident and answering the classifier's questions (register rows
 * SAFE-001 and SAFE-002; hazards HZ-013 and HZ-027) against the demo tenant. The carer records a
 * fall from a resident's record, answering the falls questions there; the nurse, who manages
 * incidents, answers one of the questions that follow on the incident's page. Each run adds its
 * own incident, marked with the run in its narrative, and changes nothing already there.
 */

const RUN = `run ${Date.now().toString(36)}`;
const PERSON = demoPerson(3);

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

  await page.getByLabel("What kind of incident was it?").selectOption("fall");
  await page
    .getByLabel("What happened", { exact: true })
    .fill(`Found on the floor beside their bed (${RUN}).`);
  // Nothing about who was called, nor the falls questions: the form asks rather than assume no.
  await page.getByRole("button", { name: "Record the incident" }).click();
  const summary = page.getByRole("alert");
  await expect(summary).toBeFocused();
  for (const words of [
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
