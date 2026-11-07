import { randomUUID } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import { demoPerson, expectAccessible, signIn } from "./support";

/**
 * Medication errors, reviews and reports on the web (slice 55; MEDS-012, MEDS-013; medicines.md
 * section 14; HZ-134) against the demo tenant. The manager raises a medication incident through the
 * API; on the web they record its medication error details from the incident, are told at the field
 * that an omitted dose reaches the person (HZ-003), and see the escalations in the API's words, the
 * clinical advice going once who was told, when and their advice are recorded. They then book,
 * move and record a resident's medication review, open the home's review tracker, and read the
 * override report, the PRN report and the error trend as tables, with a period that cannot be read
 * said at its field. Each screen is checked with axe in light and dark, with and without errors.
 */

const API_URL = process.env.API_URL ?? "http://localhost:4000";
const DEMO_TENANT = "0194d000-0000-7000-8000-000000000001";
const DEMO_LOCATION = "0194d000-0000-7000-8000-000000000101";
const RUN = randomUUID().slice(0, 8);
const PERSON = demoPerson(2);

test.describe.configure({ mode: "serial" });

const main = (page: Page) => page.getByRole("main");
const region = (page: Page, name: string) => page.getByRole("region", { name, exact: true });
/**
 * The page the form went to, then its notice. The form says the same words before it goes, so the
 * address is awaited first: acting on the old page loses the next step when the new one arrives.
 */
async function arrived(page: Page, done: string, words: string) {
  await page.waitForURL(new RegExp(`[?&]done=${done}(&|$)`));
  await expect(page.getByRole("status").getByText(words, { exact: true })).toBeVisible();
}

async function bothThemes(page: Page, name: string) {
  await expectAccessible(page, `${name} (light)`);
  await page.emulateMedia({ colorScheme: "dark" });
  await expectAccessible(page, `${name} (dark)`);
  await page.emulateMedia({ colorScheme: "light" });
}

/** A UK date some days from today, as the date boxes take it. */
function ukDate(days: number): Record<"day" | "month" | "year", string> {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    day: "numeric",
    month: "numeric",
    year: "numeric",
  }).formatToParts(new Date(Date.now() + days * 86_400_000));
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return { day: part("day"), month: part("month"), year: part("year") };
}

/** A UK date some days from today, as the page shows it (dd/mm/yyyy). */
function ukShown(days: number): string {
  const { day, month, year } = ukDate(days);
  return `${day.padStart(2, "0")}/${month.padStart(2, "0")}/${year}`;
}

/** The UK date and time some minutes ago, for the date and time boxes. */
function ukDateTime(minutesAgo: number) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    day: "numeric",
    month: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(Date.now() - minutesAgo * 60_000));
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return {
    day: part("day"),
    month: part("month"),
    year: part("year"),
    hour: part("hour"),
    minute: part("minute"),
  };
}

async function fillDate(page: Page, legend: string, date: Record<string, string>) {
  const group = main(page).getByRole("group", { name: legend });
  for (const [part, value] of Object.entries(date)) {
    await group
      .getByLabel(part.charAt(0).toUpperCase() + part.slice(1), { exact: true })
      .fill(value);
  }
}

test("hazard HZ-134 hazard HZ-003 the manager records a medication error and its follow-up", async ({
  page,
}) => {
  test.setTimeout(240_000);
  await signIn(page, "manager@example.invalid");
  const raised = await page.request.post(`${API_URL}/v1/incidents`, {
    headers: { "x-harbour-tenant": DEMO_TENANT },
    data: {
      locationId: DEMO_LOCATION,
      occurredAt: new Date(Date.now() - 2 * 3_600_000).toISOString(),
      type: "medication",
      description: `A morning dose was not given (${RUN}).`,
      emergencyServicesCalled: false,
      gpContacted: false,
      people: [{ kind: "service_user", role: "affected", personId: PERSON }],
    },
  });
  expect(raised.status(), await raised.text()).toBe(201);
  const { id } = (await raised.json()) as { id: string };

  // The incident links its medication error details.
  await page.goto(`/incidents/${id}`);
  await main(page).getByRole("link", { name: "Medication error details" }).click();
  await page.waitForURL(new RegExp(`/incidents/${id}/medication-error`));
  await expect(
    main(page).getByRole("heading", { name: "Medication error", level: 1 }),
  ).toBeVisible();
  await expect(main(page).getByText("No medication error details are recorded yet")).toBeVisible();
  await bothThemes(page, "a medication incident with no error details");

  // An omitted dose answered as not reaching the person is said at its field (HZ-003).
  await main(page).getByRole("checkbox", { name: "Dose omitted" }).check();
  const reached = main(page).getByRole("group", { name: "Did it reach the person?" });
  await reached.getByRole("radio", { name: "No", exact: true }).check();
  await main(page).getByRole("button", { name: "Record the details" }).click();
  await expect(
    main(page)
      .getByText("An omitted dose reaches the person by its absence. Answer yes or not sure.")
      .first(),
  ).toBeVisible();
  await bothThemes(page, "the medication error form with an error");

  await reached.getByRole("radio", { name: "Yes", exact: true }).check();
  await main(page).getByRole("button", { name: "Record the details" }).click();
  await arrived(page, "added", "Medication error details recorded");
  const todo = region(page, "What is still to do");
  await expect(todo.getByText("Get clinical advice")).toBeVisible();
  await expect(todo.getByText("Consider safeguarding")).toBeVisible();
  await expect(todo.getByText("How CQC is decided")).toBeVisible();
  await expect(region(page, "What was recorded").getByText("Reached the person")).toBeVisible();
  await bothThemes(page, "the medication error with its escalations");

  // Who was told, when and their advice clear the clinical advice prompt.
  await main(page).getByLabel("Who was told").fill("Out-of-hours GP");
  await fillDate(page, "When they were told", ukDateTime(30));
  await main(page).getByLabel("Their advice").fill("Give the dose now and observe.");
  await main(page).getByRole("button", { name: "Save the changes" }).click();
  await arrived(page, "changed", "Medication error details changed");
  await expect(region(page, "What is still to do").getByText("Get clinical advice")).toHaveCount(0);
  await expect(region(page, "What was recorded").getByText("Out-of-hours GP")).toBeVisible();
});

test("hazard HZ-134 the manager books, moves and records a medication review", async ({ page }) => {
  test.setTimeout(240_000);
  await signIn(page, "manager@example.invalid");
  await page.goto(`/people/${PERSON}/medicines/reviews`);
  await expect(main(page).getByRole("heading", { name: "Where the reviews stand" })).toBeVisible();
  await bothThemes(page, "a person's medication reviews");

  // A review with no date is said at its field.
  await main(page).getByRole("button", { name: "Book the review" }).click();
  await expect(
    main(page).getByText("The date the review is due must include a day, month and year").first(),
  ).toBeVisible();
  await bothThemes(page, "booking a review with an error");

  await fillDate(page, "Date the review is due", ukDate(40));
  await main(page).getByRole("button", { name: "Book the review" }).click();
  await arrived(page, "scheduled", "Review booked");

  // Move it, with a reason. Earlier runs leave their reviews here too, so each step works inside
  // this run's review only.
  const reviews = region(page, "Reviews");
  const booked = reviews
    .getByRole("listitem")
    .filter({ hasText: `Record, move or cancel the review due on ${ukShown(40)}` })
    .first();
  await booked.getByText(/^Record, move or cancel the review due on/).click();
  await booked.getByRole("radio", { name: "Move it to another date" }).check();
  await fillDate(page, "New date it is due", ukDate(45));
  await booked.getByLabel("Why is it moving?").fill(`The GP is away that week (${RUN}).`);
  await booked.getByRole("button", { name: "Move the review" }).click();
  await arrived(page, "reschedule", "Review moved");

  // Record it done, in the clinician's words.
  const moved = reviews.getByRole("listitem").filter({ hasText: `(${RUN})` });
  await expect(moved).toContainText(`Due on ${ukShown(45)}`);
  await moved.getByText(/^Record, move or cancel the review due on/).click();
  await moved.getByRole("radio", { name: "Record it as done" }).check();
  await fillDate(page, "Date it was done", ukDate(0));
  await moved.getByLabel("Clinician", { exact: true }).fill("Dr Ada Example");
  await moved.getByLabel("Their role").selectOption("gp");
  await moved.getByLabel("Outcome").fill(`No changes to the medicines (${RUN}).`);
  await moved.getByRole("button", { name: "Record the review" }).click();
  await arrived(page, "recorded", "Review recorded as done");
  // The outcome as recorded; the closed form that corrects it starts from the same words.
  await expect(
    reviews.getByRole("definition").getByText(`No changes to the medicines (${RUN}).`),
  ).toBeVisible();
  await bothThemes(page, "a person's medication reviews with one done");
});

test("hazard HZ-134 hazard HZ-119 the home's review tracker and medicines reports", async ({
  page,
}) => {
  test.setTimeout(240_000);
  await signIn(page, "manager@example.invalid");
  await page.goto("/medicines-reports");
  if (!/\/medicines-reports\/[0-9a-f-]{36}/.test(page.url())) {
    await bothThemes(page, "choose the home for the medicines reports");
  }
  await page.goto(`/medicines-reports/${DEMO_LOCATION}`);
  await expect(
    main(page).getByRole("heading", { name: "Medicines reports", level: 1 }),
  ).toBeVisible();
  await bothThemes(page, "the home's medicines reports");

  await main(page).getByRole("link", { name: "Medication review tracker" }).click();
  await expect(
    main(page).getByRole("heading", { name: "Medication review tracker", level: 1 }),
  ).toBeVisible();
  await expect(main(page).getByText(/reviews? overdue|No reviews overdue/)).toBeVisible();
  await bothThemes(page, "the medication review tracker");

  await page.goto(`/medicines-reports/${DEMO_LOCATION}/trend`);
  await expect(
    main(page).getByRole("table", { name: /^Medication errors and near misses by month/ }),
  ).toBeVisible();
  await bothThemes(page, "the medication error trend");

  await page.goto(`/medicines-reports/${DEMO_LOCATION}/prn`);
  await expect(main(page).getByRole("table", { name: /^PRN and psychotropic use/ })).toBeVisible();
  await bothThemes(page, "the PRN and psychotropic report");

  await page.goto(`/medicines-reports/${DEMO_LOCATION}/overrides`);
  await expect(
    main(page).getByRole("table", { name: /^Competence overrides and late records/ }),
  ).toBeVisible();
  await bothThemes(page, "the override report");

  // A period that cannot be read is said at its field, and nothing is read.
  await page.goto(`/medicines-reports/${DEMO_LOCATION}/overrides?from=2026-02-30&to=2026-03-01`);
  await expect(
    main(page).getByText("Enter the first day of the period as a real date.").first(),
  ).toBeVisible();
  await expect(main(page).getByRole("table")).toHaveCount(0);
  await bothThemes(page, "the override report with a period error");
});
