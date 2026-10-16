import { type APIRequestContext, expect, type Page, test } from "@playwright/test";
import { demoPerson, expectAccessible, signIn } from "./support";

/**
 * Phase 1 slice 9: reviewing and closing an incident, and preparing and submitting its statutory
 * notification (register rows SAFE-001 to SAFE-003; hazard HZ-013) against the demo tenant. The
 * nurse raises an incident and is never offered "close"; the Registered Manager sees what must be
 * done first, is refused in words when the incident changed meanwhile, and closes it. On a death
 * notification the manager prepares it, marks it ready and records it as submitted (a fresh
 * sign-in counts as the step-up). Each run adds its own incidents, marked with the run in their
 * narrative, and changes nothing already there.
 */

const RUN = `run ${Date.now().toString(36)}`;
const API_URL = process.env.API_URL ?? "http://localhost:4000";
const DEMO_TENANT = "0194d000-0000-7000-8000-000000000001";
const DEMO_LOCATION = "0194d000-0000-7000-8000-000000000101";

interface Incident {
  readonly id: string;
  readonly version: number;
  readonly classifier: {
    readonly openQuestions: readonly { key: string; kind: string }[];
    readonly notifications: readonly { id: string; kind: string }[];
  } | null;
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

/** A card on the page, named by its heading (a section labelled by it is a region). */
const card = (page: Page, name: string) => page.getByRole("region", { name, exact: true });

test.describe.configure({ mode: "serial" });

let incidentPath = "";

test("hazard HZ-013 hazard HZ-091 the nurse who raised an incident is never offered close", async ({
  page,
}) => {
  await signIn(page, "nurse@example.invalid");
  const incident = await call(page.request, "/v1/incidents", {
    locationId: DEMO_LOCATION,
    occurredAt: new Date(Date.now() - 90 * 60_000).toISOString(),
    type: "environmental",
    description: `Water came through the ceiling of the lounge (${RUN}).`,
    emergencyServicesCalled: false,
    gpContacted: false,
  });
  incidentPath = `/incidents/${incident.id}`;
  await page.goto(incidentPath);
  const manage = card(page, "Review and close");
  await expect(manage.getByRole("button", { name: "Start the review" })).toBeVisible();
  await expect(
    manage.getByText(
      "You raised this incident, so someone else who manages incidents must close it.",
    ),
  ).toBeVisible();
  await expect(manage.getByRole("button", { name: "Close the incident" })).toHaveCount(0);
  await expectAccessible(page, "review and close, raised by you");

  await manage.getByRole("button", { name: "Start the review" }).click();
  await expect(page.getByRole("status").getByText("The review has started")).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toBeFocused();
  await expectAccessible(page, "review started");
});

test("hazard HZ-013 hazard HZ-091 the manager is refused in words on a stale page, then closes it", async ({
  page,
}) => {
  test.skip(!incidentPath, "The incident was not recorded");
  await signIn(page, "manager@example.invalid");
  const id = incidentPath.split("/").at(-1) ?? "";
  await page.goto(incidentPath);
  const manage = card(page, "Review and close");
  const before = await call(page.request, `/v1/incidents/${id}`);
  if ((before.classifier?.openQuestions.length ?? 0) > 0) {
    // Questions still open: the page says so instead of offering a form the API would refuse.
    await expect(manage.getByText("Before it can close")).toBeVisible();
    await expect(manage.getByRole("button", { name: "Close the incident" })).toHaveCount(0);
    await expectAccessible(page, "close, blocked by open questions");
    await answerEverything(page.request, id);
    await page.reload();
  }

  // Empty: the reason is asked for.
  const close = page.getByRole("form", { name: "Close the incident" });
  await expect(close).toBeVisible();
  await expect(page.getByRole("form", { name: "Send it back to open" })).toBeVisible();
  await expectAccessible(page, "close, empty");

  await close.getByRole("button", { name: "Close the incident" }).click();
  const summary = page.getByRole("main").getByRole("alert");
  await expect(summary).toBeFocused();
  const words = "Say why the incident can close, in at least 3 characters and at most 1,000";
  await expect(summary.getByRole("link", { name: words })).toBeVisible();
  await expectAccessible(page, "close, with an error");

  // Meanwhile, elsewhere, someone sends it back to open: this page's copy is out of date.
  const current = await call(page.request, `/v1/incidents/${id}`);
  await call(
    page.request,
    `/v1/incidents/${id}/review`,
    { to: "open", reason: "More photos are coming.", version: current.version },
    200,
  );
  await close.getByLabel("Why can it close?").fill(`The roof was repaired (${RUN}).`);
  await close.getByRole("button", { name: "Close the incident" }).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText(
    "This changed since the page opened, perhaps because your last attempt was saved.",
  );
  await expect(page.getByRole("main").getByRole("alert")).toBeFocused();
  await expectAccessible(page, "close, refused");

  await page.reload();
  const fresh = page.getByRole("form", { name: "Close the incident" });
  await fresh.getByLabel("Why can it close?").fill(`The roof was repaired (${RUN}).`);
  await fresh.getByRole("button", { name: "Close the incident" }).click();
  await expect(page.getByRole("status").getByText("Incident closed")).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toBeFocused();
  await expect(page.getByText(`The roof was repaired (${RUN}).`)).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: "Review and close" })).toHaveCount(0);
  await expectAccessible(page, "closed");
});

test("hazard HZ-013 hazard HZ-091 the manager prepares a death notification and records it as submitted", async ({
  page,
}) => {
  await signIn(page, "manager@example.invalid");
  const incident = await call(page.request, "/v1/incidents", {
    locationId: DEMO_LOCATION,
    type: "fall",
    occurredAt: new Date(Date.now() - 30 * 60_000).toISOString(),
    description: `Found on the floor of her room, not breathing (${RUN}).`,
    emergencyServicesCalled: true,
    gpContacted: true,
    people: [{ kind: "service_user", role: "affected", personId: demoPerson(3), died: true }],
  });
  const death = incident.classifier?.notifications.find((n) => n.kind === "cqc_reg16_death");
  expect(death, "a death notification draft").toBeDefined();
  await page.goto(`/notifications/statutory/${death?.id}`);

  const prepare = page.getByRole("form", { name: "Prepare the notification" });
  await expect(prepare).toBeVisible();
  // Submitting waits until it is ready; deciding "not required" is offered.
  await expect(page.getByText("It is still a draft.")).toBeVisible();
  await expect(page.getByRole("form", { name: "Decide it is not required" })).toBeVisible();
  await expectAccessible(page, "prepare, empty");

  await prepare.getByRole("button", { name: "Save and mark ready to submit" }).click();
  const summary = page.getByRole("main").getByRole("alert");
  await expect(summary).toBeFocused();
  await expect(
    summary.getByRole("link", {
      name: "Answer this before marking it ready, or save it as a draft",
    }),
  ).toBeVisible();
  await expectAccessible(page, "prepare, with an error");

  await prepare
    .getByLabel("A description of the circumstances of the death (reg 16(3))")
    .fill(`Found at 06:10 on the floor beside her bed; paramedics confirmed death (${RUN}).`);
  await prepare.getByRole("button", { name: "Save and mark ready to submit" }).click();
  await expect(
    page.getByRole("status").getByText("Saved and marked ready to submit"),
  ).toBeVisible();

  const submit = page.getByRole("form", { name: "Record that it was submitted" });
  await expect(submit).toBeVisible();
  await expectAccessible(page, "submit, empty");
  await submit.getByRole("button", { name: "Record as submitted" }).click();
  const errors = page.getByRole("main").getByRole("alert");
  await expect(errors).toBeFocused();
  for (const words of [
    "Say when it was submitted: just now, or earlier with the date and time",
    "Enter the regulator's reference in at most 120 characters",
  ]) {
    await expect(errors.getByRole("link", { name: words })).toBeVisible();
  }
  await expectAccessible(page, "submit, with errors");

  await submit
    .getByRole("group", { name: "When was it submitted?" })
    .getByRole("radio", { name: "Just now", exact: true })
    .check();
  await submit.getByLabel("The regulator's reference").fill("CQC-000-EXAMPLE");
  await submit.getByRole("button", { name: "Record as submitted" }).click();
  await expect(page.getByRole("status").getByText("Recorded as submitted")).toBeVisible();
  await expect(page.getByText("CQC-000-EXAMPLE")).toBeVisible();
  await expect(page.getByRole("form", { name: "Record that it was submitted" })).toHaveCount(0);
  await expectAccessible(page, "submitted");
});

test("hazard HZ-013 hazard HZ-091 what to do first, then not required on a stale page is refused", async ({
  page,
  browser,
}, testInfo) => {
  // The nurse raises it, so the manager may close it once the notification is decided.
  const nurse = await browser.newContext({ baseURL: testInfo.project.use.baseURL });
  const nursePage = await nurse.newPage();
  await signIn(nursePage, "nurse@example.invalid");
  const incident = await call(nursePage.request, "/v1/incidents", {
    locationId: DEMO_LOCATION,
    type: "behaviour",
    occurredAt: new Date(Date.now() - 20 * 60_000).toISOString(),
    description: `Shouted at a visitor in the garden (${RUN}).`,
    emergencyServicesCalled: false,
    gpContacted: false,
    people: [{ kind: "service_user", role: "affected", personId: demoPerson(3) }],
    answers: [{ key: "police.involved", value: "unsure" }],
  });
  await nurse.close();
  const police = incident.classifier?.notifications.find((n) => n.kind === "cqc_reg18_police");
  expect(police, "a police notification draft").toBeDefined();
  const path = `/v1/notifications/statutory/${police?.id}`;

  // The incident page lists what to do first, the draft linked, and offers no close form.
  await signIn(page, "manager@example.invalid");
  await page.goto(`/incidents/${incident.id}`);
  const manage = card(page, "Review and close");
  await expect(manage.getByText("Before it can close")).toBeVisible();
  await expect(manage.getByRole("button", { name: "Close the incident" })).toHaveCount(0);
  const draftLink = manage.getByRole("link", { name: /^Submit, or decide not required: / });
  await expect(draftLink.first()).toBeVisible();
  await expectAccessible(page, "close, what to do first");
  await page.goto(`/notifications/statutory/${police?.id}`);
  const form = page.getByRole("form", { name: "Decide it is not required" });
  await expect(form).toBeVisible();

  // Meanwhile, elsewhere, it is marked ready: this page's copy is out of date.
  const current = await call<{ version: number }>(page.request, path);
  await call(page.request, `${path}/prepare`, { ready: true, version: current.version }, 200);

  await form.getByLabel("Why is it not required?").fill("The police were not involved.");
  await form.getByRole("button", { name: "Record as not required" }).click();
  const alert = page.getByRole("main").getByRole("alert");
  await expect(alert).toBeFocused();
  await expect(alert).toContainText("This changed since the page opened");
  await expectAccessible(page, "not required, refused");

  await page.reload();
  const fresh = page.getByRole("form", { name: "Decide it is not required" });
  await fresh.getByLabel("Why is it not required?").fill("The police were not involved.");
  await fresh.getByRole("button", { name: "Record as not required" }).click();
  await expect(page.getByRole("status").getByText("Recorded as not required")).toBeVisible();
  await expect(page.getByText("The police were not involved.")).toBeVisible();
  await expectAccessible(page, "not required, done");
});

test("hazard HZ-013 not required on a notification Harbour found needed asks for more", async ({
  page,
}) => {
  await signIn(page, "manager@example.invalid");
  const incident = await call(page.request, "/v1/incidents", {
    locationId: DEMO_LOCATION,
    type: "fall",
    occurredAt: new Date(Date.now() - 25 * 60_000).toISOString(),
    description: `Found on the floor of the bathroom, not breathing (${RUN}).`,
    emergencyServicesCalled: true,
    gpContacted: true,
    people: [{ kind: "service_user", role: "affected", personId: demoPerson(3), died: true }],
  });
  const death = incident.classifier?.notifications.find((n) => n.kind === "cqc_reg16_death");
  expect(death, "a death notification draft").toBeDefined();
  await page.goto(`/notifications/statutory/${death?.id}`);
  const form = page.getByRole("form", { name: "Decide it is not required" });
  await expect(form.getByText("Harbour found this notification is needed")).toBeVisible();
  await form.getByLabel("Why is it not required?").fill("Recorded twice.");
  await form.getByRole("button", { name: "Record as not required" }).click();
  const summary = page.getByRole("main").getByRole("alert");
  await expect(summary).toBeFocused();
  await expect(
    summary.getByRole("link", {
      name: "Tick the box to confirm you have checked the facts and the law does not need this notification",
    }),
  ).toBeVisible();
  await expectAccessible(page, "not required on a needed notification, with errors");

  await form
    .getByLabel("Why is it not required?")
    .fill(`Recorded twice: the same death is notified from its own incident (${RUN}).`);
  await form
    .getByLabel("I have checked the facts, and the law does not need this notification")
    .check();
  await form.getByRole("button", { name: "Record as not required" }).click();
  await expect(page.getByRole("status").getByText("Recorded as not required")).toBeVisible();
  await expectAccessible(page, "not required on a needed notification, done");
});
