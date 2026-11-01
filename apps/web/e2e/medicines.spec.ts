import { randomUUID } from "node:crypto";
import { type APIRequestContext, type Browser, expect, type Page, test } from "@playwright/test";
import { demoPerson, expectAccessible, signIn } from "./support";

/**
 * The medicines record (MEDS-001, MEDS-006; medicines.md section 13) against the demo tenant, with
 * the invented dm+d fixture and demo competence (MEDICINES_FIXTURES, on outside production). The
 * manager transcribes a medicine found in dm+d; it is Not yet checked, and the manager is not
 * offered the second check; the nurse checks it against the source; the manager reconciles a
 * change from a source and a line to a decision and completion; then stops it with a reason. The
 * person and their allergies are beside every form. Each step is checked with axe in light and
 * dark. Each run uses a resident with nothing on their MAR and no open reconciliation, so it can
 * run again on the same database (six residents).
 */

const API_URL = process.env.API_URL ?? "http://localhost:4000";
const DEMO_TENANT = "0194d000-0000-7000-8000-000000000001";
const RUN = randomUUID().slice(0, 8);
const PRODUCT = { search: "ibuprofen", name: "Ibuprofen 200mg tablets" };

test.describe.configure({ mode: "serial" });

const main = (page: Page) => page.getByRole("main");
const region = (page: Page, name: string | RegExp) => main(page).getByRole("region", { name });

async function bothThemes(page: Page, name: string) {
  await expectAccessible(page, `${name} (light)`);
  await page.emulateMedia({ colorScheme: "dark" });
  await expectAccessible(page, `${name} (dark)`);
  await page.emulateMedia({ colorScheme: "light" });
}

async function signedIn(browser: Browser, email: string): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await signIn(page, email);
  return page;
}

/** A resident with nothing on their MAR and no reconciliation open. */
async function freeResident(request: APIRequestContext): Promise<string> {
  for (let n = 1; n <= 6; n++) {
    const id = demoPerson(n);
    const r = await request.get(`${API_URL}/v1/people/${id}/medicines`, {
      headers: { "x-harbour-tenant": DEMO_TENANT },
    });
    if (!r.ok()) continue;
    const body = (await r.json()) as { entries: unknown[]; openReconciliationId: string | null };
    if (body.entries.length === 0 && body.openReconciliationId === null) return id;
  }
  throw new Error("No demo resident has an empty MAR: reseed the database");
}

async function fillWhen(
  page: Page,
  scope: ReturnType<Page["getByRole"]>,
  legend: string,
  at: Date,
) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  })
    .formatToParts(at)
    .reduce<Record<string, string>>((acc, p) => ({ ...acc, [p.type]: p.value }), {});
  const group = scope.getByRole("group", { name: legend });
  await group.getByLabel("Day").fill(parts.day ?? "");
  await group.getByLabel("Month").fill(parts.month ?? "");
  await group.getByLabel("Year").fill(parts.year ?? "");
  await group.getByLabel("Hour").fill(parts.hour ?? "");
  await group.getByLabel("Minute").fill(parts.minute ?? "");
  void page;
}

test("hazard HZ-005 hazard HZ-121 a medicine is transcribed, checked by another person, reconciled and stopped", async ({
  browser,
}) => {
  test.setTimeout(300_000);
  const manager = await signedIn(browser, "manager@example.invalid");
  const person = await freeResident(manager.request);
  const tab = `/people/${person}/medicines`;

  await manager.goto(tab);
  await expect(
    main(manager).getByRole("heading", { name: "Medicines", exact: true }),
  ).toBeVisible();
  await bothThemes(manager, "medicines tab");

  // Transcribe from dm+d: route and unit only from what dm+d permits.
  await main(manager).getByRole("link", { name: "Add a medicine" }).click();
  const form = region(manager, "Add a medicine");
  await form.getByRole("button", { name: "Add the medicine" }).click();
  await expect(
    form.getByText("Find the medicine and choose it from the list.").first(),
  ).toBeVisible();
  await bothThemes(manager, "add a medicine with errors");
  await form.getByLabel("Find the medicine").fill(PRODUCT.search);
  await form.getByRole("button", { name: "Search medicines" }).click();
  await form.getByRole("radio", { name: PRODUCT.name }).check();
  await expect(form.getByText(`Chosen: ${PRODUCT.name}`, { exact: true })).toBeVisible();
  // The person and their allergies are beside the medicine.
  await expect(form.getByRole("region", { name: "Who this medicine is for" })).toContainText(
    "Allergies:",
  );
  await form.getByLabel("Route").selectOption({ label: "Oral" });
  await form.getByLabel("Dose unit").selectOption({ label: "tablet" });
  const slot = form.getByRole("group", { name: "Dose time 1" });
  await slot.getByLabel("Time", { exact: true }).fill("22:00");
  await slot.getByLabel(/How much/).fill("1");
  await form.getByLabel("Prescriber").fill("Dr A Example");
  await fillWhen(manager, form, "Starts", new Date(Date.now() + 86_400_000));
  await form.getByLabel("Kind of source").selectOption({ label: "Prescription" });
  await form.getByLabel("Source reference").fill(`FP10 ${RUN}`);
  await bothThemes(manager, "add a medicine");
  await form.getByRole("button", { name: "Add the medicine" }).click();
  await manager.waitForURL(/\/medicines\/[0-9a-f-]{36}/);
  const entryUrl = manager.url().split("?")[0] ?? "";
  await expect(main(manager).getByText("Medicine added. It is not yet checked.")).toBeVisible();
  await expect(main(manager).getByText("Not yet checked").first()).toBeVisible();
  await expect(main(manager)).toContainText("1 tablet every day at 22:00");
  // The transcriber is not offered the second check.
  await expect(region(manager, "Second check")).toHaveCount(0);
  await bothThemes(manager, "medicine not yet checked");

  // The nurse checks it against the source.
  const nurse = await signedIn(browser, "nurse@example.invalid");
  await nurse.goto(entryUrl);
  const check = region(nurse, "Second check");
  await check.getByRole("button", { name: "Record the second check" }).click();
  await expect(
    check.getByText("Tick to confirm you compared it with the source document itself.").first(),
  ).toBeVisible();
  await check.getByLabel("I compared this entry with the source document itself").check();
  await check.getByRole("radio", { name: "It matches the source" }).check();
  await bothThemes(nurse, "second check");
  await check.getByRole("button", { name: "Record the second check" }).click();
  await expect(
    main(nurse).getByRole("status").filter({ hasText: "Second check recorded." }),
  ).toBeVisible();
  await expect(main(nurse).getByText("Checked", { exact: true }).first()).toBeVisible();
  await nurse.context().close();

  // A change reconciled: a source, a line, the manager's decision, completion.
  await manager.goto(tab);
  await region(manager, "Reconcile a change")
    .getByRole("button", { name: "Start a reconciliation" })
    .click();
  await manager.waitForURL(/\/medicines\/reconciliations\/[0-9a-f-]{36}/);
  await expect(main(manager)).toContainText("Harbour decides nothing here.");
  const sources = region(manager, "1. Sources");
  await sources.getByLabel("Kind of source").selectOption({ label: "Clinic letter" });
  await sources.getByLabel("Source reference").fill(`Clinic letter ${RUN}`);
  await fillWhen(manager, sources, "When it was received", new Date(Date.now() - 3_600_000));
  await sources
    .getByLabel("Why it is still current")
    .fill("Received this morning, the latest list");
  await sources.getByRole("button", { name: "Add a source" }).click();
  await expect(sources.getByText("Source added.")).toBeVisible();
  const linesCard = region(manager, "2. Lines from the sources");
  await linesCard.getByLabel("From which source").selectOption({ index: 1 });
  await linesCard.getByLabel("The line as written").fill("Ibuprofen 200mg one at night");
  await linesCard.getByRole("radio", { name: "Continue" }).check();
  await linesCard.getByLabel("Find the medicine").fill(PRODUCT.search);
  await linesCard.getByRole("button", { name: "Search medicines" }).click();
  await linesCard.getByRole("radio", { name: PRODUCT.name }).check();
  await linesCard.getByRole("button", { name: "Add a line" }).click();
  await expect(linesCard.getByText("Line added.")).toBeVisible();
  await bothThemes(manager, "reconciliation sources and lines");

  const decide = region(manager, "3. Decide each medicine on the MAR");
  await decide.getByRole("radio", { name: "Continue as it is" }).check();
  // It starts tomorrow: continuing asks why that version still stands.
  await decide
    .getByLabel("Why the version starting later still stands")
    .fill("The clinic letter confirms it starts tomorrow");
  await decide.getByRole("checkbox", { name: /Continue: Ibuprofen 200mg one at night/ }).check();
  await decide.getByRole("button", { name: `Save the decision about ${PRODUCT.name}` }).click();
  await expect(decide.getByText("Decision: Continue as it is")).toBeVisible();

  const complete = region(manager, "5. Complete the reconciliation");
  await complete.getByLabel("I compared the medicines with the person's allergies").check();
  await complete.getByRole("radio", { name: "Yes" }).check();
  await bothThemes(manager, "reconciliation decided");
  await complete.getByRole("button", { name: "Complete the reconciliation" }).click();
  await expect(
    main(manager).getByRole("status").filter({ hasText: "Reconciliation completed." }),
  ).toBeVisible();
  await expect(main(manager).getByText("Completed", { exact: true }).first()).toBeVisible();

  // Stopped by a person, with a reason and the instruction's source.
  await manager.goto(entryUrl);
  const stop = region(manager, "Stop this medicine");
  await fillWhen(manager, stop, "Stops from", new Date(Date.now() + 2 * 86_400_000));
  await stop.getByLabel("Why it stops").fill("Pain settled; GP stopped it");
  await stop.getByLabel("Kind of source").selectOption({ label: "Prescriber's instruction" });
  await stop.getByLabel("Source reference").fill(`GP call ${RUN}`);
  await stop.getByRole("button", { name: `Stop ${PRODUCT.name}` }).click();
  await expect(
    main(manager).getByRole("status").filter({ hasText: "Medicine stopped." }),
  ).toBeVisible();
  await expect(region(manager, "Every version")).toContainText("Pain settled; GP stopped it");
  await bothThemes(manager, "medicine stopped");
  await manager.context().close();
});
