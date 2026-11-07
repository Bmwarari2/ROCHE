import { randomUUID } from "node:crypto";
import {
  type APIRequestContext,
  type Browser,
  expect,
  type Locator,
  type Page,
  test,
} from "@playwright/test";
import { demoPerson, expectAccessible, signIn } from "./support";

/**
 * Medicines stock, ordering, disposal and temperatures on the web (slice 55; MEDS-008;
 * medicines.md section 15) against the demo tenant, with the invented dm+d fixture
 * (MEDICINES_FIXTURES). The manager puts a medicine on a resident's MAR through the API. On the
 * web the manager sets the home's 28-day cycle, adds a fridge and records a reading in range and
 * one out of range (its state an icon and words, with the API's words on what happens next;
 * HZ-132), starts an order for a cycle and submits it by hand, then opens the resident's stock
 * item, receives the order line, counts (a difference needs a reason) and records a disposal
 * witnessed by the nurse, who confirms it in her own session. Each screen is checked with axe in
 * light and dark, with and without errors.
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

async function typeDate(scope: Locator, legend: string, iso: string) {
  const [year, month, day] = iso.split("-");
  const group = scope.getByRole("group", { name: legend });
  await group.getByLabel("Day").fill(String(Number(day)));
  await group.getByLabel("Month").fill(String(Number(month)));
  await group.getByLabel("Year").fill(year ?? "");
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

/** The name the order groups a resident's medicines under. */
async function fullName(request: APIRequestContext, person: string): Promise<string> {
  const r = await request.get(`${API_URL}/v1/people/${person}`, { headers });
  expect(r.ok()).toBe(true);
  const body = (await r.json()) as { givenName: string; familyName: string };
  return `${body.givenName} ${body.familyName}`.trim();
}

async function transcribe(request: APIRequestContext, person: string): Promise<string> {
  const found = await request.get(`${API_URL}/v1/medicines/products?q=paracetamol`, { headers });
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
  if (!product) throw new Error("The dm+d fixture has no paracetamol: is MEDICINES_FIXTURES on?");
  const unit =
    product.permittedDoseUnits.find((u) => u.name === "tablet") ?? product.permittedDoseUnits[0];
  const route = product.permittedRoutes[0];
  if (!unit || !route) throw new Error("The fixture product has no unit or route");
  const r = await request.post(`${API_URL}/v1/people/${person}/medicines`, {
    headers,
    data: {
      product: { vmpId: product.vmpId, ampId: null, name: product.name },
      route,
      directions: {
        kind: "regular",
        schedule: {
          pattern: { kind: "every_day" },
          times: [{ time: "08:00", dose: { kind: "amount", quantity: 2, unit } }],
        },
      },
      prescriber: "Dr A Example",
      startsAt: new Date(Date.now() - 86_400_000).toISOString(),
      source: { kind: "prescription", reference: `FP10 ${RUN}` },
    },
  });
  expect(r.status(), await r.text()).toBe(201);
  return product.name;
}

/** A cycle date of this run's own, so a second run never meets the first run's order. */
function runCycleDate(): string {
  const start = Date.UTC(2027, 0, 4);
  const offset = Number.parseInt(RUN.slice(0, 4), 16) % 600;
  return new Date(start + offset * 86_400_000).toISOString().slice(0, 10);
}

test("hazard HZ-132 hazard HZ-003 the manager orders, receives, counts and disposes of stock, and records temperatures", async ({
  browser,
}) => {
  test.setTimeout(300_000);
  const manager = await signedIn(browser, "manager@example.invalid");
  const person = await freeResident(manager.request);
  const product = await transcribe(manager.request, person);

  // The home's stock page: the cycle, the orders and the storage.
  await manager.goto("/medicines-stock");
  await manager.waitForURL(/\/medicines-stock/);
  if (!/\/medicines-stock\/[0-9a-f-]{36}/.test(manager.url())) {
    await bothThemes(manager, "choose the home for medicines stock");
    await manager.goto(`/medicines-stock/${DEMO_LOCATION}`);
  }
  await expect(
    main(manager).getByRole("heading", { name: "Medicines stock", level: 1 }),
  ).toBeVisible();
  await bothThemes(manager, "the home's medicines stock");

  // The cycle: an empty date is refused at its field, then saved.
  const cycle = main(manager).getByRole("region", { name: "Ordering cycle" });
  const group = cycle.getByRole("group", { name: "First day of a cycle" });
  for (const box of ["Day", "Month", "Year"]) await group.getByLabel(box).fill("");
  await cycle.getByRole("button", { name: "Save cycle" }).click();
  await expect(main(manager).getByRole("alert")).toBeFocused();
  await bothThemes(manager, "the cycle with errors");
  await typeDate(cycle, "First day of a cycle", "2026-11-02");
  await cycle.getByRole("button", { name: "Save cycle" }).click();
  await manager.waitForURL(/done=cycle/);
  await expect(main(manager).getByRole("status").first()).toContainText("Ordering cycle saved");

  // A fridge, then its readings.
  const storage = main(manager).getByRole("region", { name: "Storage and temperatures" });
  await storage.getByRole("button", { name: "Add storage" }).click();
  await expect(main(manager).getByRole("alert")).toBeFocused();
  await bothThemes(manager, "add storage with errors");
  const fridge = `Treatment room fridge ${RUN}`;
  await storage.getByRole("radio", { name: "Medicines fridge" }).check();
  await storage.getByLabel("Name").fill(fridge);
  await storage.getByRole("button", { name: "Add storage" }).click();
  await manager.waitForURL(/done=storage/);
  await main(manager)
    .getByRole("link", { name: `${fridge} (fridge)` })
    .click();
  await manager.waitForURL(/\/storage\//);
  await bothThemes(manager, "a fridge with no readings");

  const record = main(manager).getByRole("region", { name: "Record a reading" });
  // Two decimal places are refused, so a reading at the edge is never rounded into range.
  await record.getByLabel("Temperature now, in degrees Celsius").fill("8.04");
  await record.getByRole("button", { name: "Record reading" }).click();
  await expect(main(manager).getByRole("alert")).toBeFocused();
  await bothThemes(manager, "a reading with errors");
  await record.getByLabel("Temperature now, in degrees Celsius").fill("5.0");
  await record.getByRole("button", { name: "Record reading" }).click();
  await expect(record.getByText("In range", { exact: true })).toBeVisible();
  await record.getByLabel("Temperature now, in degrees Celsius").fill("9.5");
  await record.getByRole("button", { name: "Record reading" }).click();
  // The state and the figures take focus, so they are read out; the web names no direction (HZ-132).
  await expect(record.getByText("Out of range", { exact: true })).toBeVisible();
  await expect(record.getByRole("region", { name: "The reading just recorded" })).toBeFocused();
  // The API's own words on what happens next; never whether the medicines can be used.
  await expect(record.getByText(/asked to check the storage and ask the pharmacist/)).toBeVisible();
  const readings = main(manager).getByRole("region", { name: "Latest readings" });
  await expect(readings.getByText("Out of range", { exact: true }).first()).toBeVisible();
  await expect(readings.getByText("The range was 2 to 8 degrees Celsius.").first()).toBeVisible();
  await bothThemes(manager, "a fridge with a reading out of range");

  // An order for this run's cycle, submitted by hand.
  await manager.goto(`/medicines-stock/${DEMO_LOCATION}`);
  await main(manager).getByRole("link", { name: "Start an order" }).click();
  await manager.waitForURL(/\/orders\/new/);
  const lines = main(manager).getByRole("region", { name: "Medicines to order" });
  await typeDate(lines, "First day of the cycle this order is for", runCycleDate());
  await lines.getByRole("button", { name: "Start order" }).click();
  await expect(lines.getByText("Enter a quantity for at least one medicine").first()).toBeVisible();
  await bothThemes(manager, "a new order with errors");
  // Each resident's medicines are grouped under their name; earlier runs leave others to order.
  await lines
    .getByRole("group", { name: await fullName(manager.request, person), exact: true })
    .getByLabel(`${product}, quantity in tablet`)
    .fill("56");
  await bothThemes(manager, "a new order");
  await lines.getByRole("button", { name: "Start order" }).click();
  await manager.waitForURL(/\/orders\/[0-9a-f-]{36}\?done=created/);
  await expect(main(manager).getByText("Draft", { exact: true })).toBeVisible();
  await bothThemes(manager, "a draft order");
  const submit = main(manager).getByRole("region", { name: "Submit the order" });
  await submit.getByRole("radio", { name: "By hand, sent another way" }).check();
  await submit.getByRole("button", { name: "Submit order" }).click();
  await manager.waitForURL(/done=submitted/);
  await expect(main(manager).getByText("Submitted", { exact: true })).toBeVisible();
  // The arrival takes focus again, not lost with the form that has gone.
  await expect(
    main(manager)
      .getByRole("status")
      .filter({ hasText: /submitted/i })
      .first(),
  ).toBeFocused();
  await bothThemes(manager, "a submitted order");

  // The person's stock: open an item from the MAR.
  await manager.goto(`/people/${person}/medicines/stock`);
  const open = main(manager).getByRole("region", { name: "Open a stock item" });
  await open.getByRole("button", { name: "Open stock item" }).click();
  await expect(main(manager).getByRole("alert")).toBeFocused();
  await bothThemes(manager, "the person's stock with errors");
  await open.getByLabel("Medicine").selectOption({ label: product });
  await open.getByRole("button", { name: "Open stock item" }).click();
  await manager.waitForURL(/\/medicines\/stock\?done=opened/);
  await bothThemes(manager, "the person's stock");
  await main(manager)
    .getByRole("region", { name: "Stock items" })
    .getByRole("link", { name: product })
    .click();
  await manager.waitForURL(/\/medicines\/stock\/[0-9a-f-]{36}/);

  // A receipt filling the order line.
  const receipt = main(manager).getByRole("region", { name: "Record medicines received" });
  await receipt.getByLabel("Quantity in tablet").fill("56");
  await receipt.getByLabel("Order line it fills").selectOption({ index: 1 });
  await receipt.getByRole("button", { name: "Record receipt" }).click();
  await manager.waitForURL(/done=received/);
  await expect(main(manager).getByText("56 tablet").first()).toBeVisible();

  // A count that differs needs a reason.
  const count = main(manager).getByRole("region", { name: "Count the stock" });
  await count.getByLabel("How many tablet you counted").fill("54");
  await count.getByRole("button", { name: "Record count" }).click();
  await expect(main(manager).getByRole("alert")).toBeFocused();
  await bothThemes(manager, "a count with errors");
  await count.getByLabel("Why the count differs from the balance").fill("Two found damaged");
  await count.getByRole("button", { name: "Record count" }).click();
  await manager.waitForURL(/done=counted/);

  // A disposal witnessed by the nurse.
  const disposal = main(manager).getByRole("region", { name: "Dispose of medicines" });
  await disposal.getByLabel("Quantity in tablet").fill("2");
  await disposal
    .getByLabel("Why they are disposed of")
    .selectOption({ label: "Dropped or spoilt" });
  await disposal.getByRole("radio", { name: "A witness, who will confirm it" }).check();
  await disposal.getByRole("button", { name: "Record disposal" }).click();
  await expect(main(manager).getByRole("alert")).toBeFocused();
  await bothThemes(manager, "a disposal with errors");
  await disposal.getByLabel("Witness", { exact: true }).selectOption({ label: "Nell Nurse" });
  await disposal.getByRole("button", { name: "Record disposal" }).click();
  await manager.waitForURL(/done=disposed_awaiting/);
  await expect(main(manager).getByRole("status").first()).toContainText(
    "waiting for the witness to confirm it",
  );
  await bothThemes(manager, "a stock item after a disposal");
  const itemUrl = new URL(manager.url());

  // The nurse confirms it in her own session.
  const nurse = await signedIn(browser, "nurse@example.invalid");
  await nurse.goto(itemUrl.pathname);
  await main(nurse).getByRole("link", { name: "Confirm this disposal as its witness" }).click();
  await nurse.waitForURL(/\/stock\/disposals\//);
  await expect(main(nurse).getByText(product).first()).toBeVisible();
  await bothThemes(nurse, "confirm a disposal");
  await main(nurse).getByRole("button", { name: "I witnessed this disposal" }).click();
  await nurse.waitForURL(/\/medicines\/stock\?done=witnessed/);
  await expect(main(nurse).getByRole("status").first()).toContainText(
    "Disposal confirmed as witness",
  );
  await bothThemes(nurse, "the person's stock after witnessing");
});
