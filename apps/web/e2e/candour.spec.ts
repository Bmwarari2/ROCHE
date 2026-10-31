import { type APIRequestContext, type Browser, expect, type Page, test } from "@playwright/test";
import { demoPerson, expectAccessible, signIn, signInWithDemoPasskey } from "./support";

/**
 * Phase 1: the duty of candour record on an incident (register row SAFE-007; regulation 20;
 * safety.md rule 5; hazards HZ-013 and HZ-091) against the demo tenant. The nurse raises an
 * incident about a person we support; the Registered Manager records the threshold decision,
 * tells the person in person, sends the written notification, shares the results and keeps the
 * correspondence, each step offered only once nothing is missing for it, and the review card says
 * the candour record must finish before the incident can close. A decision that it is not
 * notifiable takes a reason, and a stale page is refused in words. Each run adds its own incidents
 * and documents, marked with the run, and changes nothing already there. Axe in both themes.
 */

const RUN = `run ${Date.now().toString(36)}`;
const API_URL = process.env.API_URL ?? "http://localhost:4000";
const DEMO_TENANT = "0194d000-0000-7000-8000-000000000001";
const DEMO_LOCATION = "0194d000-0000-7000-8000-000000000101";
const PERSON = demoPerson(4);
const PDF = Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n");

async function call<T>(
  request: APIRequestContext,
  method: "get" | "post" | "put",
  path: string,
  data?: object,
): Promise<T> {
  const response = await request[method](`${API_URL}${path}`, {
    headers: { "x-harbour-tenant": DEMO_TENANT },
    ...(data ? { data } : {}),
  });
  expect(response.ok(), `${path} ${await response.text()}`).toBe(true);
  return (await response.json()) as T;
}

/** A PDF about the person, as if added to their record: the candour forms choose from these. */
async function addDocument(request: APIRequestContext, title: string): Promise<string> {
  const query = new URLSearchParams({ category: "person_document", title, personId: PERSON });
  const response = await request.post(`${API_URL}/v1/documents?${query}`, {
    headers: { "x-harbour-tenant": DEMO_TENANT, "content-type": "application/pdf" },
    data: PDF,
  });
  expect(response.status(), await response.text()).toBe(201);
  return ((await response.json()) as { id: string }).id;
}

/** A medication error the nurse records about a person we support. */
async function nurseRecords(
  browser: Browser,
  baseURL: string | undefined,
  description: string,
  options: {
    readonly people?: readonly string[];
    readonly answers?: readonly { key: string; value: unknown }[];
  } = {},
): Promise<string> {
  const nurse = await browser.newContext({ baseURL });
  const nursePage = await nurse.newPage();
  await signIn(nursePage, "nurse@example.invalid");
  const incident = await call<{ id: string }>(nursePage.request, "post", "/v1/incidents", {
    locationId: DEMO_LOCATION,
    occurredAt: new Date(Date.now() - 2 * 3_600_000).toISOString(),
    type: "medication",
    description: `${description} (${RUN}).`,
    emergencyServicesCalled: false,
    gpContacted: true,
    people: (options.people ?? [PERSON]).map((personId) => ({
      kind: "service_user",
      role: "affected",
      personId,
    })),
    ...(options.answers ? { answers: options.answers } : {}),
  });
  await nurse.close();
  return incident.id;
}

const region = (page: Page, name: string) => page.getByRole("region", { name, exact: true });
const arrived = (page: Page, words: string) =>
  expect(page.getByRole("status").getByText(words, { exact: true })).toBeVisible();

/** The UK date and time an hour ago, for the date and time boxes. */
function anHourAgo(): Record<"day" | "month" | "year" | "hour" | "minute", string> {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(Date.now() - 3_600_000));
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return {
    day: part("day"),
    month: part("month"),
    year: part("year"),
    hour: part("hour"),
    minute: part("minute"),
  };
}

test.describe.configure({ mode: "serial" });

test("hazard HZ-013 hazard HZ-091 the manager records the duty of candour from the threshold decision to closing it", async ({
  page,
  browser,
}, testInfo) => {
  test.setTimeout(180_000);
  const id = await nurseRecords(
    browser,
    testInfo.project.use.baseURL,
    "The evening dose was given twice",
  );
  // A passkey sign-in: recording the candour notification at the end needs step-up.
  await signInWithDemoPasskey(page);
  const record = await addDocument(page.request, `Note of the conversation (${RUN})`);
  const letter = await addDocument(page.request, `Candour letter (${RUN})`);
  await page.goto(`/incidents/${id}`);

  // No record yet: the threshold decision is asked for, nothing assumed.
  const candour = region(page, "Duty of candour");
  const threshold = candour.getByRole("form", { name: "Record the threshold decision" });
  await expect(threshold).toBeVisible();
  await expectAccessible(page, "candour, no record");
  await threshold.getByRole("button", { name: "Save the decision" }).click();
  const summary = page.getByRole("main").getByRole("alert");
  await expect(summary).toBeFocused();
  for (const words of [
    "Say whether it is a notifiable safety incident",
    "Say when: just now, or earlier with the date and time",
    "Enter the name and role of the health care professional, in 2 to 200 characters",
  ]) {
    await expect(summary.getByRole("link", { name: words })).toBeVisible();
  }
  await expectAccessible(page, "candour threshold, with errors");

  await threshold
    .getByRole("group", { name: "Is it a notifiable safety incident?" })
    .getByRole("radio", { name: "Yes", exact: true })
    .check();
  await threshold
    .getByRole("group", { name: "When was the decision made?" })
    .getByRole("radio", { name: "Just now", exact: true })
    .check();
  await threshold
    .getByLabel("Whose opinion does the decision record?")
    .fill(`Dr Example, GP (${RUN})`);
  await threshold.getByRole("button", { name: "Save the decision" }).click();
  await arrived(page, "Duty of candour record saved");
  await expect(page.getByRole("heading", { level: 1 })).toBeFocused();

  // The clocks in words and icons: telling them is due now, the letter has the organisation's
  // target from the rate table, never a legal deadline.
  await expect(candour.getByText("Threshold decision needed")).toBeVisible();
  await expect(candour.getByText("Due now")).toBeVisible();
  await expect(
    candour.getByText(/^Written notification: your organisation's target is \d+ working days?/),
  ).toBeVisible();
  await expect(candour.getByText(/This is a target, not a legal deadline/)).toBeVisible();
  await candour.getByRole("button", { name: "Move on: tell the person" }).click();
  await arrived(page, "Duty of candour: tell the person in person next");

  // While it is open the incident cannot close: the review card says so, linked.
  const review = region(page, "Review and close");
  await expect(review.getByText("Before it can close")).toBeVisible();
  await expect(
    review.getByRole("link", {
      name: "Finish the duty of candour record below, or record that it is not notifiable",
    }),
  ).toBeVisible();
  // The next steps say what is missing instead of offering what the API would refuse.
  await expect(
    candour.getByText("Before you can move on to the written notification"),
  ).toBeVisible();
  await expect(candour.getByText("Record telling the person in person.")).toBeVisible();
  await expect(candour.getByRole("button", { name: "Move on: written notification" })).toHaveCount(
    0,
  );
  await expectAccessible(page, "candour, tell the person");

  const verbal = candour.getByRole("form", { name: "Record telling the person in person" });
  await verbal
    .getByRole("group", { name: "When were they told?" })
    .getByRole("radio", { name: "Just now", exact: true })
    .check();
  await verbal.getByLabel("Who told them?").fill("The Registered Manager\nThe nurse in charge");
  await verbal
    .getByRole("group", { name: "Were they told in person?" })
    .getByRole("radio", { name: "Yes", exact: true })
    .check();
  await verbal.getByLabel("A true account of all the facts known").check();
  await verbal.getByLabel("What further enquiries are planned").check();
  await verbal.getByLabel("An apology").check();
  await verbal.getByLabel("The written record of the conversation (optional)").selectOption(record);
  await verbal.getByRole("button", { name: "Save telling them in person" }).click();
  await arrived(page, "Duty of candour record saved");
  // The clock says it was done, in words with its time.
  await expect(candour.getByText(/^Told in person \d{2}\/\d{2}\/\d{4} \d{2}:\d{2}/)).toBeVisible();
  await candour.getByRole("button", { name: "Move on: written notification" }).click();
  await arrived(page, "Duty of candour: the written notification is next");

  const written = candour.getByRole("form", { name: "Record the written notification" });
  await written
    .getByRole("group", { name: "When was it sent?" })
    .getByRole("radio", { name: "Just now", exact: true })
    .check();
  await written.getByLabel("A true account of all the facts known").check();
  await written.getByLabel("Details of the further enquiries and their results so far").check();
  await written.getByLabel("An apology").check();
  await written.getByLabel("A copy of the written notification (optional)").selectOption(letter);
  await written.getByRole("button", { name: "Save the written notification" }).click();
  await arrived(page, "Duty of candour record saved");
  await expect(candour.getByText("Before you can close the record")).toBeVisible();
  await expect(
    candour.getByText(
      "Record when the results of the further enquiries were shared with them (regulation 20(4)(c)).",
    ),
  ).toBeVisible();
  await expectAccessible(page, "candour, written notification sent");

  const followUp = candour.getByRole("form", { name: "Record the results and correspondence" });
  const when = anHourAgo();
  const shared = followUp.getByRole("group", {
    name: "When were the results of the enquiries shared? (optional)",
  });
  await shared.getByLabel("Day").fill(when.day);
  await shared.getByLabel("Month").fill(when.month);
  await shared.getByLabel("Year").fill(when.year);
  await shared.getByLabel("Hour").fill(when.hour);
  await shared.getByLabel("Minute").fill(when.minute);
  await followUp.getByRole("checkbox", { name: `Candour letter (${RUN})` }).check();
  await followUp.getByLabel("Outcome (optional)").fill(`Results shared at a meeting (${RUN}).`);
  await followUp.getByRole("button", { name: "Save the results and correspondence" }).click();
  await arrived(page, "Duty of candour record saved");

  const close = candour.getByRole("form", { name: "Close the duty of candour record" });
  await close.getByLabel("Why can it close?").fill(`Everything was shared and kept (${RUN}).`);
  await close.getByRole("button", { name: "Close the record" }).click();
  await arrived(page, "Duty of candour record closed");
  await expect(candour.getByText("Finished", { exact: true })).toBeVisible();
  await expect(candour.getByRole("form")).toHaveCount(0);
  await expect(
    candour.getByRole("link", { name: /^Download Candour letter/ }).first(),
  ).toBeVisible();
  await expectAccessible(page, "candour, closed");
  await page.emulateMedia({ colorScheme: "dark" });
  await expectAccessible(page, "candour, closed, dark theme");
  await page.emulateMedia({ colorScheme: "light" });

  // The duty of candour notification is recorded with the letter's copy as its evidence, never
  // a regulator's reference (review H2).
  const detail = await call<{ classifier: { notifications: { id: string; kind: string }[] } }>(
    page.request,
    "get",
    `/v1/incidents/${id}`,
  );
  const draft = detail.classifier.notifications.find((n) => n.kind === "candour");
  expect(draft, "a candour notification draft").toBeDefined();
  await page.goto(`/notifications/statutory/${draft?.id}`);
  const prepare = page.getByRole("form", { name: "Prepare the notification" });
  const boxes = prepare.getByRole("textbox");
  for (let i = 0; i < (await boxes.count()); i += 1) {
    await boxes.nth(i).fill(`Recorded on the duty of candour record (${RUN}).`);
  }
  await prepare.getByRole("button", { name: "Save and mark ready to submit" }).click();
  await arrived(page, "Saved and marked ready to submit");
  const submit = page.getByRole("form", { name: "Record that it was submitted" });
  await expect(submit.getByText(/goes to the person, not a regulator/)).toBeVisible();
  await expect(submit.getByLabel("The regulator's reference")).toHaveCount(0);
  await submit
    .getByRole("group", { name: "When was it submitted?" })
    .getByRole("radio", { name: "Just now", exact: true })
    .check();
  await submit.getByRole("button", { name: "Record as submitted" }).click();
  await arrived(page, "Recorded as submitted");
  await expectAccessible(page, "candour notification recorded");
});

test("hazard HZ-013 hazard HZ-091 not notifiable takes a reason, and a stale page is refused in words", async ({
  page,
  browser,
}, testInfo) => {
  const id = await nurseRecords(
    browser,
    testInfo.project.use.baseURL,
    "A tablet was found on the floor after the round",
  );
  await signIn(page, "manager@example.invalid");
  // The decision, recorded through the API: the page then offers the step it points to.
  await call(page.request, "put", `/v1/incidents/${id}/candour`, {
    personId: PERSON,
    threshold: {
      notifiable: false,
      decidedAt: new Date(Date.now() - 600_000).toISOString(),
      decidedBy: `A health care professional (${RUN})`,
    },
    version: 0,
  });
  await page.goto(`/incidents/${id}`);
  const candour = region(page, "Duty of candour");
  await expect(candour.getByText("Threshold decision needed")).toBeVisible();
  // Not notifiable: no clocks run.
  await expect(candour.getByText("Due now")).toHaveCount(0);
  const form = candour.getByRole("form", { name: "Record that it is not notifiable" });
  await expect(form).toBeVisible();
  await expectAccessible(page, "candour, not notifiable");

  await form.getByRole("button", { name: "Record as not notifiable" }).click();
  await expect(page.getByRole("main").getByRole("alert")).toBeFocused();
  await expectAccessible(page, "candour, not notifiable, with an error");

  // Meanwhile, elsewhere, the record changes: this page's copy is out of date.
  const now = await call<{ record: { version: number } }>(
    page.request,
    "get",
    `/v1/incidents/${id}/candour`,
  );
  await call(page.request, "put", `/v1/incidents/${id}/candour`, {
    outcome: `Checked by the deputy (${RUN}).`,
    version: now.record.version,
  });
  await form.getByLabel("Why is it not notifiable?").fill("No harm came to the person.");
  await form.getByRole("button", { name: "Record as not notifiable" }).click();
  const alert = page.getByRole("main").getByRole("alert");
  await expect(alert).toBeFocused();
  await expect(alert).toContainText("This changed since the page opened");
  await expectAccessible(page, "candour, not notifiable, refused");

  await page.reload();
  const fresh = region(page, "Duty of candour").getByRole("form", {
    name: "Record that it is not notifiable",
  });
  await fresh.getByLabel("Why is it not notifiable?").fill(`No harm came to the person (${RUN}).`);
  await fresh.getByRole("button", { name: "Record as not notifiable" }).click();
  await arrived(page, "Duty of candour: recorded as not notifiable");
  await expect(
    region(page, "Duty of candour").getByText("Not a notifiable safety incident", { exact: true }),
  ).toBeVisible();
  await page.emulateMedia({ colorScheme: "dark" });
  await expectAccessible(page, "candour, not notifiable, done, dark theme");
  await page.emulateMedia({ colorScheme: "light" });
});

test("hazard HZ-013 hazard HZ-091 a decision that differs from Harbour's finding takes a reason and a tick", async ({
  page,
  browser,
}, testInfo) => {
  const id = await nurseRecords(
    browser,
    testInfo.project.use.baseURL,
    "A tablet was crushed against the care plan and the person choked",
    {
      answers: [
        { key: "candour.unintended_or_unexpected", value: "yes" },
        { key: "harm.body_structure_changed", value: "yes" },
      ],
    },
  );
  await signIn(page, "manager@example.invalid");
  await page.goto(`/incidents/${id}`);
  const candour = region(page, "Duty of candour");
  const threshold = candour.getByRole("form", { name: "Record the threshold decision" });
  // Harbour's finding beside the question, and the regulation's words with the rate table's period.
  await expect(
    threshold.getByText(
      "Harbour found, on the answers recorded, that this may be a notifiable safety incident.",
    ),
  ).toBeVisible();
  await expect(
    threshold.getByText(
      /during the provision of a regulated activity.*continuous period of at least \d+ days.*are likely to experience.*if left untreated/,
    ),
  ).toBeVisible();
  await threshold
    .getByRole("group", { name: "Is it a notifiable safety incident?" })
    .getByRole("radio", { name: "No", exact: true })
    .check();
  await threshold
    .getByRole("group", { name: "When was the decision made?" })
    .getByRole("radio", { name: "Just now", exact: true })
    .check();
  await threshold
    .getByLabel("Whose opinion does the decision record?")
    .fill(`Dr Example, GP (${RUN})`);
  await expect(threshold.getByText(/Your answer differs from what Harbour found/)).toBeVisible();
  await threshold.getByRole("button", { name: "Save the decision" }).click();
  const summary = page.getByRole("main").getByRole("alert");
  await expect(summary).toBeFocused();
  for (const words of [
    "Say why in at least 20 characters and at most 1,000",
    "Tick the box to confirm the decision",
  ]) {
    await expect(summary.getByRole("link", { name: words })).toBeVisible();
  }
  await expectAccessible(page, "candour decision differs, with errors");

  await threshold
    .getByLabel("Why does the decision differ?")
    .fill(`The GP found no lasting harm after the review (${RUN}).`);
  await threshold
    .getByLabel(
      "I have checked the facts with the health care professional, and this is the decision",
    )
    .check();
  await threshold.getByRole("button", { name: "Save the decision" }).click();
  await arrived(page, "Duty of candour: recorded as not notifiable");
  await expect(
    region(page, "Duty of candour").getByText("Not a notifiable safety incident", { exact: true }),
  ).toBeVisible();
  await page.emulateMedia({ colorScheme: "dark" });
  await expectAccessible(page, "candour decision differs, done, dark theme");
  await page.emulateMedia({ colorScheme: "light" });
});

test("hazard HZ-013 closing names everyone still to be told when two people were harmed", async ({
  page,
  browser,
}, testInfo) => {
  const second = demoPerson(5);
  const id = await nurseRecords(
    browser,
    testInfo.project.use.baseURL,
    "Two people were given each other's evening medicines",
    {
      people: [PERSON, second],
      answers: [
        { key: "candour.unintended_or_unexpected", value: "yes" },
        { key: "harm.body_structure_changed", value: "yes" },
      ],
    },
  );
  await signIn(page, "manager@example.invalid");
  // One record, finished for the first person only (they could not be contacted).
  const path = `/v1/incidents/${id}/candour`;
  let view = await call<{ record: { version: number } }>(page.request, "put", path, {
    personId: PERSON,
    threshold: {
      notifiable: true,
      decidedAt: new Date(Date.now() - 600_000).toISOString(),
      decidedBy: `A health care professional (${RUN})`,
    },
    version: 0,
  });
  view = await call(page.request, "post", `${path}/step`, {
    to: "verbal_due",
    version: view.record.version,
  });
  view = await call(page.request, "put", path, {
    contactAttempts: [{ at: new Date().toISOString(), note: `Phoned twice, no answer (${RUN}).` }],
    version: view.record.version,
  });
  await call(page.request, "post", `${path}/step`, {
    to: "no_contact",
    reason: "No answer after two calls.",
    version: view.record.version,
  });
  await page.goto(`/incidents/${id}`);
  const review = region(page, "Review and close");
  await expect(review.getByText("Before it can close")).toBeVisible();
  await expect(
    review.getByRole("link", {
      name: /^Still to be told under the duty of candour: Elsie Mock\. /,
    }),
  ).toBeVisible();
  await expect(review.getByRole("button", { name: "Close the incident" })).toHaveCount(0);
  await expectAccessible(page, "close, still to be told");
  await page.emulateMedia({ colorScheme: "dark" });
  await expectAccessible(page, "close, still to be told, dark theme");
  await page.emulateMedia({ colorScheme: "light" });
});
