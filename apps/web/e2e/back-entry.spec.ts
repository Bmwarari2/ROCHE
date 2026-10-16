import { expect, type Page, test } from "@playwright/test";
import { demoPerson, expectAccessible, signIn } from "./support";

/**
 * Slice 11 web part B: entering a paper record from an outage on the care record forms
 * (operations.md section 14; hazards HZ-017, HZ-009) against the demo tenant. The nurse declares
 * an outage that ended three hours ago through the API, then enters notes for Ben (resident 2) on
 * the screen: from a paper form inside the outage, from a form dated after it (with the reason
 * asked for), and from memory for a time in it (the API asks why it is not from paper). Its
 * window ends before the downtime journey's, which runs later against the same database, so
 * outages never overlap. Every state is checked with axe.
 */

const API_URL = process.env.API_URL ?? "http://localhost:4000";
const DEMO_TENANT = "0194d000-0000-7000-8000-000000000001";
const DEMO_LOCATION = "0194d000-0000-7000-8000-000000000101";
const RUN = `run ${Date.now().toString(36)}`;
const T0 = Date.now();
const BEN = demoPerson(2);

test.describe.configure({ mode: "serial" });

/** A moment `minutes` from the start of the run, as the UK wall clock the boxes ask for. */
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
      .formatToParts(new Date(T0 + minutes * 60_000))
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
const PAPER_TIME = "Date and time written on the paper form";

test("hazard HZ-017 the nurse enters paper records from an outage, each labelled, every state in words", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await signIn(page, "nurse@example.invalid");
  const response = await page.request.post(`${API_URL}/v1/locations/${DEMO_LOCATION}/outages`, {
    headers: { "x-harbour-tenant": DEMO_TENANT },
    data: {
      kind: "power",
      description: `Power cut in the evening (${RUN}).`,
      startedAt: new Date(Math.floor((T0 - 200 * 60_000) / 60_000) * 60_000).toISOString(),
      endedAt: new Date(Math.floor((T0 - 170 * 60_000) / 60_000) * 60_000).toISOString(),
    },
  });
  expect(response.status(), await response.text()).toBe(201);

  await page.goto(`/people/${BEN}/notes`);
  const when = page.getByRole("group", { name: "When did it happen?" });
  await expect(when.getByRole("radio", { name: /^From a paper downtime form/ })).toBeVisible();
  await expectAccessible(page, "note form with the paper choice");

  // The paper choice asks for the outage and the time written, with nothing filled in.
  await page.getByLabel("Note", { exact: true }).fill(`Settled after a warm drink (${RUN}).`);
  await when.getByRole("radio", { name: /^From a paper downtime form/ }).check();
  const outage = page.getByRole("group", { name: "Which outage was it written in?" });
  await expect(outage.getByRole("radio", { name: /^Power cut, from / })).not.toBeChecked();
  await expect(
    page.getByRole("group", { name: PAPER_TIME }).getByLabel("Hour", { exact: true }),
  ).toHaveValue("");
  await expectAccessible(page, "paper fields");
  await page.getByRole("button", { name: "Save note" }).click();
  await expect(alertIn(page)).toBeFocused();
  await expect(alertIn(page)).toContainText("Choose the outage the paper form was written in");
  await expect(alertIn(page)).toContainText("The date and time written on the paper form");
  await expectAccessible(page, "paper record refused");

  await outage.getByRole("radio", { name: /^Power cut, from / }).check();
  await fillWhen(page, PAPER_TIME, -185);
  await page.getByLabel("Form reference (optional)").fill("DT-1");
  await page.getByRole("button", { name: "Save note" }).click();
  await expect(main(page).getByRole("status").getByText("Note saved")).toBeVisible();
  const saved = page
    .getByRole("listitem")
    .filter({ hasText: `Settled after a warm drink (${RUN}).` })
    .first();
  await expect(saved.getByText("Entered from a paper record", { exact: true })).toBeVisible();
  await expect(saved.locator("[data-back-entry]")).toContainText("Reference ");
  await expectAccessible(page, "paper record saved");

  // A form dated after the outage ended: the reason is asked for, then sent.
  await page.getByLabel("Note", { exact: true }).fill(`Night check done (${RUN}).`);
  await when.getByRole("radio", { name: /^From a paper downtime form/ }).check();
  await outage.getByRole("radio", { name: /^Power cut, from / }).check();
  await fillWhen(page, PAPER_TIME, -160);
  await page.getByRole("button", { name: "Save note" }).click();
  await expect(alertIn(page)).toBeFocused();
  await expect(alertIn(page)).toContainText("The time on the form is outside the outage");
  await expectAccessible(page, "outside the outage refused");
  await page
    .getByLabel("If the time on the form is outside the outage, why? (optional)")
    .fill("Form dated after the power came back");
  await page.getByRole("button", { name: "Save note" }).click();
  await expect(main(page).getByRole("status").getByText("Note saved")).toBeVisible();

  // Written later from memory for a time in the outage: the API asks why it is not from paper.
  await page.getByLabel("Note", { exact: true }).fill(`Mouth care given (${RUN}).`);
  await when.getByRole("radio", { name: "Earlier" }).check();
  await fillWhen(page, "Date and time it happened", -190);
  await page.getByRole("button", { name: "Save note" }).click();
  await expect(alertIn(page)).toBeFocused();
  await expect(alertIn(page)).toContainText("This time falls in the outage from");
  const why = page.getByLabel("Why was this not written on paper during the outage?");
  await expect(why).toBeVisible();
  await expectAccessible(page, "not from paper asked");
  await why.fill("Remembered at handover");
  await page.getByRole("button", { name: "Save note" }).click();
  await expect(main(page).getByRole("status").getByText("Note saved")).toBeVisible();
  const memory = page
    .getByRole("listitem")
    .filter({ hasText: `Mouth care given (${RUN}).` })
    .first();
  await expect(memory.getByText("Written later, not from paper", { exact: true })).toBeVisible();
  await expect(memory.getByText(/^Reason: Remembered at handover/)).toBeVisible();
  await expectAccessible(page, "not from paper saved");
});
