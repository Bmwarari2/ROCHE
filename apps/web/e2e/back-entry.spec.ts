import { type APIRequestContext, expect, type Page, test } from "@playwright/test";
import { demoPerson, expectAccessible, signIn } from "./support";

/**
 * Slice 11 web part B: entering a paper record from an outage on the care record forms
 * (operations.md section 14; hazards HZ-017, HZ-009, HZ-006) against the demo tenant. The nurse
 * declares an outage through the API, open from ten minutes before a base time laid out after
 * every outage already at the location (so a retry, or another journey, never overlaps), then
 * enters notes for Ben (resident 2) on the screen: from paper inside the outage; on the chart,
 * body map, activity and visit forms the paper choice is opened and scanned; the outage is closed
 * with a true end before one paper note (H-207); a form dated after the end asks why; an entry
 * from memory for a time in the outage asks why it is not from paper; and correcting the paper
 * note now outside the outage asks why (H-208). Every state is checked with axe.
 */

const API_URL = process.env.API_URL ?? "http://localhost:4000";
const DEMO_TENANT = "0194d000-0000-7000-8000-000000000001";
const DEMO_LOCATION = "0194d000-0000-7000-8000-000000000101";
const RUN = `run ${Date.now().toString(36)}`;
const MINUTE = 60_000;
const SPAN_MINUTES = 10;
const BEN = demoPerson(2);
const headers = { "x-harbour-tenant": DEMO_TENANT };
let BASE = Math.floor(Date.now() / MINUTE) * MINUTE;

test.describe.configure({ mode: "serial" });

/** BASE after every outage at the location, so this journey's window overlaps none of them. */
async function layOutAfterExistingOutages(request: APIRequestContext) {
  const url = `${API_URL}/v1/locations/${DEMO_LOCATION}/outages`;
  type Item = {
    id: string;
    state: string;
    startedAt: string;
    endedAt: string | null;
    version: number;
  };
  const read = async () =>
    ((await (await request.get(url, { headers })).json()) as { items: Item[] }).items;
  for (const o of (await read()).filter((x) => x.state === "declared")) {
    const cancelled = await request.post(`${API_URL}/v1/outages/${o.id}/cancel`, {
      headers,
      data: { reason: "Left open by an earlier test attempt.", version: o.version },
    });
    if (cancelled.ok()) continue;
    await request.post(`${API_URL}/v1/outages/${o.id}/close`, {
      headers,
      data: {
        endedAt: new Date(Date.parse(o.startedAt) + MINUTE).toISOString(),
        version: o.version,
      },
    });
  }
  const latest = Math.max(
    0,
    ...(await read())
      .filter((o) => o.state !== "cancelled" && o.endedAt)
      .map((o) => Date.parse(o.endedAt as string)),
  );
  const earliest = Math.ceil(latest / MINUTE) * MINUTE + SPAN_MINUTES * MINUTE;
  while (Math.floor(Date.now() / MINUTE) * MINUTE < earliest) {
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  BASE = Math.floor(Date.now() / MINUTE) * MINUTE;
}

/** A moment `minutes` from BASE, as the UK wall clock the boxes ask for. */
function ukParts(minutes: number) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/London",
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(new Date(BASE + minutes * MINUTE))
      .map((p) => [p.type, p.value]),
  );
  return [
    ["Day", parts.day ?? ""],
    ["Month", parts.month ?? ""],
    ["Year", parts.year ?? ""],
    ["Hour", parts.hour ?? ""],
    ["Minute", parts.minute ?? ""],
  ] as const;
}

async function fillWhen(page: Page, legend: string, minutes: number) {
  const group = page.getByRole("group", { name: legend });
  for (const [label, value] of ukParts(minutes)) {
    await group.getByLabel(label, { exact: true }).fill(value);
  }
}

const main = (page: Page) => page.getByRole("main");
const alertIn = (page: Page) => main(page).getByRole("alert");
const PAPER = /^From a paper downtime form/;
const PAPER_TIME = "Date and time written on the paper form";
const OUTAGE = "Which outage was it written in?";

/** Writes a note from a paper form at `minutes`, inside the outage chosen. */
async function paperNote(page: Page, text: string, minutes: number) {
  const form = page.getByRole("region", { name: "Write a note" });
  await form.getByLabel("Note", { exact: true }).fill(text);
  await form.getByRole("radio", { name: PAPER }).check();
  await form.getByRole("group", { name: OUTAGE }).getByRole("radio").first().check();
  await fillWhen(page, PAPER_TIME, minutes);
  await form.getByRole("button", { name: "Save note" }).click();
}

const noteSaved = (page: Page) =>
  expect(page.getByRole("region", { name: "Write a note" }).getByRole("status")).toHaveText(
    "Note saved",
  );
const noteIn = (page: Page, text: string) =>
  page
    .getByRole("list", { name: /^Notes about / })
    .getByRole("listitem")
    .filter({ hasText: text })
    .first();

test("hazard HZ-017 the nurse enters paper records from an outage, each labelled, every state in words", async ({
  page,
}) => {
  test.setTimeout(900_000);
  await signIn(page, "nurse@example.invalid");
  await layOutAfterExistingOutages(page.request);
  const declared = await page.request.post(`${API_URL}/v1/locations/${DEMO_LOCATION}/outages`, {
    headers,
    data: {
      kind: "power",
      description: `Power cut in the evening (${RUN}).`,
      startedAt: new Date(BASE - 10 * MINUTE).toISOString(),
    },
  });
  expect(declared.status(), await declared.text()).toBe(201);
  const outage = (await declared.json()) as { id: string; version: number };

  await page.goto(`/people/${BEN}/notes`);
  const form = page.getByRole("region", { name: "Write a note" });
  await expect(form.getByRole("radio", { name: PAPER })).toBeVisible();
  await expectAccessible(page, "note form with the paper choice");

  // The paper choice asks for the outage and the time written, with nothing filled in.
  await form.getByLabel("Note", { exact: true }).fill(`Settled after a warm drink (${RUN}).`);
  await form.getByRole("radio", { name: PAPER }).check();
  await expect(
    form.getByRole("group", { name: OUTAGE }).getByRole("radio").first(),
  ).not.toBeChecked();
  await expect(
    form.getByRole("group", { name: PAPER_TIME }).getByLabel("Hour", { exact: true }),
  ).toHaveValue("");
  await expectAccessible(page, "paper fields");
  await form.getByRole("button", { name: "Save note" }).click();
  await expect(alertIn(page)).toBeFocused();
  await expect(alertIn(page)).toContainText("Choose the outage the paper form was written in");
  await expect(alertIn(page)).toContainText("The date and time written on the paper form");
  await expectAccessible(page, "paper record refused");

  await form.getByRole("group", { name: OUTAGE }).getByRole("radio").first().check();
  await fillWhen(page, PAPER_TIME, -9);
  await form.getByLabel("Form reference (optional)").fill("DT-1");
  await form.getByRole("button", { name: "Save note" }).click();
  await noteSaved(page);
  const saved = noteIn(page, `Settled after a warm drink (${RUN}).`);
  await expect(saved.getByText("Entered from a paper record", { exact: true })).toBeVisible();
  await expect(saved.locator("[data-back-entry]")).toContainText("Reference ");
  await expectAccessible(page, "paper record saved");

  // A second paper note, later corrected after the outage's true end is set before it (H-207).
  await paperNote(page, `Repositioned on the left (${RUN}).`, -3);
  await noteSaved(page);

  // The other forms offer the same choice: opened and scanned on each.
  // The before-saving notice is for vital signs (NEWS2) readings only.
  await page.goto(`/people/${BEN}/charts?record=vitals`);
  await main(page).getByRole("radio", { name: PAPER }).check();
  await expect(main(page).getByRole("group", { name: OUTAGE })).toBeVisible();
  await expect(
    main(page).getByText("A reading from a paper form is from the time written on it.", {
      exact: false,
    }),
  ).toBeVisible();
  await expectAccessible(page, "chart entry from paper");
  await page.goto(`/people/${BEN}/body-map`);
  await main(page).getByRole("radio", { name: PAPER }).check();
  await expect(main(page).getByRole("group", { name: OUTAGE })).toBeVisible();
  await expectAccessible(page, "body map mark from paper");
  await page.goto(`/people/${BEN}/activities`);
  await main(page).getByRole("radio", { name: PAPER }).first().check();
  await main(page).getByRole("radio", { name: PAPER }).last().check();
  await expect(main(page).getByRole("group", { name: OUTAGE })).toHaveCount(2);
  await expectAccessible(page, "activity and visit from paper");

  // Systems are back: the true end is set before the second note (H-207).
  const closed = await page.request.post(`${API_URL}/v1/outages/${outage.id}/close`, {
    headers,
    data: { endedAt: new Date(BASE - 5 * MINUTE).toISOString(), version: outage.version },
  });
  expect(closed.status(), await closed.text()).toBe(200);

  // A form dated after the outage ended: the reason is asked for, then sent.
  await page.goto(`/people/${BEN}/notes`);
  await paperNote(page, `Night check done (${RUN}).`, -4);
  await expect(alertIn(page)).toBeFocused();
  await expect(alertIn(page)).toContainText("The time on the form is outside the outage");
  await expectAccessible(page, "outside the outage refused");
  await form
    .getByLabel("Why is the time outside the outage? (only if it is)")
    .fill("Form dated after the power came back");
  await form.getByRole("button", { name: "Save note" }).click();
  await noteSaved(page);

  // Written later from memory for a time in the outage: the API asks why it is not from paper.
  await form.getByLabel("Note", { exact: true }).fill(`Mouth care given (${RUN}).`);
  await form.getByRole("radio", { name: /^Earlier/ }).check();
  await fillWhen(page, "Date and time it happened", -8);
  await form.getByRole("button", { name: "Save note" }).click();
  await expect(alertIn(page)).toBeFocused();
  await expect(alertIn(page)).toContainText("This time falls in the outage from");
  const why = form.getByLabel("Why was this not written on paper during the outage?");
  await expect(why).toBeVisible();
  await expectAccessible(page, "not from paper asked");
  await why.fill("Remembered at handover");
  await form.getByRole("button", { name: "Save note" }).click();
  await noteSaved(page);
  const memory = noteIn(page, `Mouth care given (${RUN}).`);
  await expect(memory.getByText("Written later, not from paper", { exact: true })).toBeVisible();
  await expect(memory.getByText(/^Reason: Remembered at handover/)).toBeVisible();
  await expectAccessible(page, "not from paper saved");

  // Correcting the paper note now after the true end: the API asks why it is outside (H-208).
  const repositioned = noteIn(page, `Repositioned on the left (${RUN}).`);
  await repositioned.getByRole("button", { name: "Correct this note" }).click();
  await repositioned.getByLabel("Corrected note").fill(`Repositioned on the right (${RUN}).`);
  await repositioned.getByLabel("Reason for the correction").fill("Wrong side written");
  await repositioned.getByRole("button", { name: "Save correction" }).click();
  await expect(alertIn(page)).toBeFocused();
  const outside = repositioned.getByLabel("Why is the time outside the outage?");
  await expect(outside).toBeVisible();
  await expectAccessible(page, "correction asks why outside");
  await outside.fill("Form written after the power came back");
  await repositioned.getByRole("button", { name: "Save correction" }).click();
  await expect(main(page).getByText(`Repositioned on the right (${RUN}).`)).toBeVisible();
});
