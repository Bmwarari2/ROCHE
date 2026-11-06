import { randomUUID } from "node:crypto";
import { type APIRequestContext, type Browser, expect, type Page, test } from "@playwright/test";
import { demoPerson, expectAccessible, signIn } from "./support";

/**
 * The medicines round on the web (slice 53; MEDS-002 to MEDS-004; medicines.md section 16) against
 * the demo tenant, with the invented dm+d fixture and demo competence (MEDICINES_FIXTURES). The
 * manager puts a when-required and a scheduled medicine on a resident's eMAR through the API; on
 * the web the nurse opens the home's medicines round, then the resident's, and records each dose on
 * its own page, with the person and every allergy beside the medicine (HZ-007). The when-required
 * medicine then shows when it was last given (HZ-117) and the scheduled dose its outcome (HZ-003).
 * Each screen is checked with axe in light and dark, with and without errors.
 */

const API_URL = process.env.API_URL ?? "http://localhost:4000";
const DEMO_TENANT = "0194d000-0000-7000-8000-000000000001";
const DEMO_LOCATION = "0194d000-0000-7000-8000-000000000101";
const RUN = randomUUID().slice(0, 8);

test.describe.configure({ mode: "serial" });

const main = (page: Page) => page.getByRole("main");
const headers = { "x-harbour-tenant": DEMO_TENANT };

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
    const r = await request.get(`${API_URL}/v1/people/${id}/medicines`, { headers });
    if (!r.ok()) continue;
    const body = (await r.json()) as { entries: unknown[]; openReconciliationId: string | null };
    if (body.entries.length === 0 && body.openReconciliationId === null) return id;
  }
  throw new Error("No demo resident has an empty MAR: reseed the database");
}

/** The UK clock time a minute ago, so a scheduled dose is due now. */
function ukTimeNow(): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(Date.now() - 60_000));
}

async function transcribe(
  request: APIRequestContext,
  person: string,
  search: string,
  directions: (unit: { code: string; name: string }) => unknown,
  extra: Record<string, unknown> = {},
) {
  const found = await request.get(`${API_URL}/v1/medicines/products?q=${search}`, { headers });
  expect(found.ok()).toBe(true);
  const product = (
    (await found.json()) as {
      items: {
        vmpId: string;
        name: string;
        permittedRoutes: { code: string; name: string }[];
        permittedDoseUnits: { code: string; name: string }[];
      }[];
    }
  ).items[0];
  if (!product) throw new Error(`The dm+d fixture has no ${search}: is MEDICINES_FIXTURES on?`);
  const unit =
    product.permittedDoseUnits.find((u) => u.name === "tablet") ?? product.permittedDoseUnits[0];
  const route = product.permittedRoutes[0];
  if (!unit || !route) throw new Error("The fixture product has no unit or route");
  const r = await request.post(`${API_URL}/v1/people/${person}/medicines`, {
    headers,
    data: {
      product: { vmpId: product.vmpId, ampId: null, name: product.name },
      route,
      directions: directions(unit),
      prescriber: "Dr A Example",
      startsAt: new Date(Date.now() - 86_400_000).toISOString(),
      source: { kind: "prescription", reference: `FP10 ${RUN}` },
      ...extra,
    },
  });
  expect(r.status(), await r.text()).toBe(201);
  return product.name;
}

test("hazard HZ-007 hazard HZ-117 hazard HZ-003 the nurse records a when-required and a scheduled dose on the round", async ({
  browser,
}) => {
  test.setTimeout(300_000);
  const manager = await signedIn(browser, "manager@example.invalid");
  const person = await freeResident(manager.request);
  const product = await transcribe(
    manager.request,
    person,
    "ibuprofen",
    (unit) => ({
      kind: "when_required",
      dose: { kind: "amount", quantity: 1, unit },
      maxQuantityPer24Hours: 4,
    }),
    { indication: "Pain" },
  );
  await transcribe(
    manager.request,
    person,
    "paracetamol",
    (unit) => ({
      kind: "regular",
      schedule: {
        pattern: { kind: "every_day" },
        times: [{ time: ukTimeNow(), dose: { kind: "amount", quantity: 1, unit } }],
      },
    }),
    // Recorded today with today's earlier dose kept due, so it is on the round now.
    { earlierDosesDueReason: "Due this morning and not given before it was transcribed" },
  );

  const nurse = await signedIn(browser, "nurse@example.invalid");
  // The home's round: each person by room, their doses and when-required medicines.
  await nurse.goto(`/medicines-round/${DEMO_LOCATION}`);
  await expect(
    main(nurse).getByRole("heading", { name: "Medicines round", level: 1 }),
  ).toBeVisible();
  await bothThemes(nurse, "the home's medicines round");

  // The person's round.
  await nurse.goto(`/people/${person}/medicines/round`);
  const prn = main(nurse).getByRole("region", { name: "When-required medicines" });
  await expect(prn).toContainText(product);
  await expect(prn).toContainText("not given on the eMAR yet");
  await bothThemes(nurse, "the person's medicines round");

  // A when-required dose: the person and every allergy are beside the medicine.
  await prn.getByRole("link", { name: `Record a dose of ${product}` }).click();
  await nurse.waitForURL(/\/medicines\/round\/record\?entry=/);
  const form = main(nurse).getByRole("region", { name: `Record ${product}` });
  await expect(form.getByRole("region", { name: "Who this medicine is for" })).toContainText(
    "Allergies:",
  );
  await expect(form.getByRole("region", { name: "The medicine" })).toContainText("For: Pain");
  await form.getByRole("button", { name: "Record the dose" }).click();
  await expect(form.getByText("Choose what happened.").first()).toBeVisible();
  await bothThemes(nurse, "record a dose with errors");
  await form.getByRole("radio", { name: "Given", exact: true }).check();
  await expect(form.getByLabel("Amount given, in tablet")).toHaveValue("1");
  await bothThemes(nurse, "record a dose");
  await form.getByRole("button", { name: "Record the dose" }).click();
  await nurse.waitForURL(/\/medicines\/round\?done=recorded/);
  await expect(main(nurse).getByRole("status")).toContainText("Dose recorded.");
  await expect(main(nurse).getByRole("region", { name: "When-required medicines" })).toContainText(
    "Last given",
  );

  // A scheduled dose due now, refused, with the reason.
  const doses = main(nurse).getByRole("region", { name: "Doses" });
  await doses
    .getByRole("link", { name: /^Record / })
    .first()
    .click();
  await nurse.waitForURL(/\/medicines\/round\/record\?entry=.*&due=/);
  const scheduled = main(nurse).getByRole("region", { name: /^Record / });
  await scheduled.getByRole("radio", { name: "Refused", exact: true }).check();
  await scheduled
    .getByLabel("Why", { exact: true })
    .selectOption({ label: "The person declined it" });
  await bothThemes(nurse, "record a refused dose");
  await scheduled.getByRole("button", { name: "Record the dose" }).click();
  await nurse.waitForURL(/\/medicines\/round\?done=recorded/);
  await expect(main(nurse).getByRole("region", { name: "Doses" })).toContainText(
    "Outcome recorded",
  );
});
