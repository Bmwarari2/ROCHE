import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { expectAccessible, signIn, signInWithDemoPasskey } from "./support";

/**
 * Register row PEOP-010 on the web: the record's Leaving tab for a discharge, a transfer and a
 * death, each worked through its checklist to the archived record (people.md, "Web: leaving the
 * service"). Each run records and admits its own people through the API (`POST /v1/people`, the
 * pre-admission assessment, the decision and the admission), named with the run, so the demo
 * residents are never changed and the journey runs again on the same database. The beds they use
 * are released on discharge, and a room held after a death is cleared at the end.
 *
 * Hazards verified: HZ-001 (an archived or departed record reads as such, in words, on the list,
 * the header and the tab, and offers nothing after archive); HZ-013 (a death drafts the
 * regulator's notification and the medical examiner's information pack, which the checklist links
 * to and follows). Separation of duties and step-up for the person's money come from the API and
 * are said in words. Every state is checked with axe in the light and dark themes.
 */

test.describe.configure({ mode: "serial" });

const API_URL = process.env.API_URL ?? "http://localhost:4000";
const API_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../api");
const TENANT = "0194d000-0000-7000-8000-000000000001";
const LOCATION = "0194d000-0000-7000-8000-000000000101";
const RESIDENTIAL = "0194d000-0000-7000-8000-000000000202";
const RUN = `Run${Date.now().toString(36)}`;
const headers = { "x-harbour-tenant": TENANT };

const main = (page: Page) => page.getByRole("main");
const status = (page: Page) => main(page).getByRole("status").filter({ hasText: /\S/ });
const item = (page: Page, title: string | RegExp) =>
  main(page)
    .getByRole("listitem")
    .filter({ has: page.getByRole("heading", { level: 4, name: title }) });

/** Today in the UK, as the API's dates are. */
const ukToday = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(new Date());

async function call<T>(page: Page, method: string, url: string, data?: unknown): Promise<T> {
  const response = await page.request.fetch(`${API_URL}${url}`, {
    method,
    headers,
    ...(data === undefined ? {} : { data }),
  });
  expect(response.ok(), `${method} ${url}: ${await response.text()}`).toBe(true);
  return (await response.json()) as T;
}

interface Summary {
  readonly id: string;
  readonly version: number;
}

/**
 * Records an invented person as an enquiry and admits them into a free bed at Harbour House, as
 * the signed-in manager: the pre-admission assessment, the decision to admit and the admission.
 */
async function admit(
  page: Page,
  givenName: string,
): Promise<{ readonly id: string; readonly roomId: string }> {
  const now = () => new Date().toISOString();
  const created = await call<Summary>(page, "POST", "/v1/people", {
    locationId: LOCATION,
    givenName,
    familyName: `Example ${RUN}`,
    dateOfBirth: "1936-04-04",
  });
  const id = created.id;
  await call(page, "POST", `/v1/people/${id}/status`, {
    to: "pre_admission",
    effectiveAt: now(),
    serviceId: RESIDENTIAL,
    placementTypeSought: "permanent",
    version: created.version,
  });
  const view = await call<{
    assessment: { version: number; completeness: { outstanding: { key: string }[] } };
  }>(page, "GET", `/v1/people/${id}/pre-admission`);
  const sections = Object.fromEntries(
    view.assessment.completeness.outstanding.map(({ key }) => [
      key,
      key === "equipment"
        ? { status: "not_applicable", notApplicableReason: "Walks without aids" }
        : key === "medicines"
          ? {
              status: "complete",
              medicines: [
                { name: "Paracetamol", dose: "1 g", route: "oral", frequency: "As needed" },
              ],
            }
          : { status: "complete", notes: "Discussed with the person." },
    ]),
  );
  await call(page, "PUT", `/v1/people/${id}/pre-admission`, {
    sections,
    informationSources: ["person"],
    personInvolvement: { involved: true },
    version: view.assessment.version,
  });
  await call(page, "POST", `/v1/people/${id}/admission-decisions`, {
    canMeetNeeds: "yes",
    reasons: "We can meet these needs in full at Harbour House.",
    plannedAdmissionOn: ukToday(),
    toldWho: "The person",
    toldAt: now(),
  });
  const board = await call<{
    rooms: { roomId: string; status: string; beds: { bed: number; occupied: boolean }[] }[];
  }>(page, "GET", `/v1/locations/${LOCATION}/beds`);
  const room = board.rooms.find((r) => r.status === "available" && r.beds.some((b) => !b.occupied));
  expect(room, "a free bed at Harbour House").toBeDefined();
  const bed = room?.beds.find((b) => !b.occupied)?.bed ?? 1;
  const summary = await call<Summary>(page, "GET", `/v1/people/${id}`);
  await call(page, "POST", `/v1/people/${id}/admission`, {
    serviceId: RESIDENTIAL,
    placementType: "permanent",
    startDate: ukToday(),
    roomId: room?.roomId,
    bed,
    admittedAt: now(),
    version: summary.version,
  });
  return { id, roomId: room?.roomId ?? "" };
}

/** A belonging and a key, held by the home, so the exit has something to return. */
async function holdPropertyAndKey(page: Page, id: string) {
  await call(page, "POST", `/v1/people/${id}/property`, {
    description: `Reading glasses (${RUN})`,
    category: "sensory_aid",
    quantity: 1,
    receivedOn: ukToday(),
    acknowledgement: { signer: "person", name: "The person", signedAt: new Date().toISOString() },
  });
  await call(page, "POST", `/v1/people/${id}/keys`, {
    label: `Room key (${RUN})`,
    issuedOn: ukToday(),
    issuedTo: "person",
  });
}

async function checkBothThemes(page: Page, name: string) {
  await page.emulateMedia({ colorScheme: "light" });
  await expectAccessible(page, name);
  await page.emulateMedia({ colorScheme: "dark" });
  await expectAccessible(page, `${name}, dark theme`);
  await page.emulateMedia({ colorScheme: "light" });
}

async function openLeaving(page: Page, id: string) {
  await page.goto(`/people/${id}/leaving`);
  await expect(
    main(page).getByRole("heading", { level: 2, name: "Leaving the service" }),
  ).toBeVisible();
}

/** Clicks the first enabled button the locator finds, waiting for the page to say it saved. */
async function clickAndWait(page: Page, button: Locator, saved: string | RegExp) {
  await button.first().click();
  await expect(status(page)).toContainText(saved);
}

/**
 * Marks every item still to do that this person may tick, except those named, as done: one at a
 * time, as each save opens the tab again.
 */
async function tickRemaining(page: Page, except: RegExp) {
  for (let guard = 0; guard < 30; guard++) {
    const buttons = main(page).getByRole("button", { name: /^Mark as done: / });
    const names = await buttons.evaluateAll((els) =>
      els.map((e) => e.getAttribute("aria-label") ?? ""),
    );
    const next = names.find((name) => !except.test(name));
    if (!next) return;
    const button = main(page).getByRole("button", { name: next, exact: true });
    await button.click();
    // The tab opens again with the item done: its button has gone.
    await expect(button).toHaveCount(0);
  }
  throw new Error("The checklist did not finish");
}

/** Archives the record: it asks again first, as archiving cannot be undone. */
async function archive(page: Page) {
  await main(page).getByRole("button", { name: "Archive the record" }).click();
  await expect(main(page).getByText(/^Archive this record\? It cannot be undone/)).toBeVisible();
  await expectAccessible(page, "archive, asked again");
  await clickAndWait(
    page,
    main(page).getByRole("button", { name: "Yes, archive the record" }),
    "Record archived.",
  );
}

/** The record offers nothing once archived, and says so with an icon and a word. */
async function expectArchived(page: Page, id: string) {
  await openLeaving(page, id);
  await expect(page.getByTestId("archived-notice")).toContainText("Archived");
  await expect(page.getByTestId("archived-notice")).toContainText(
    "Nothing can be added or changed.",
  );
  await expect(main(page).locator("[data-person-status='archived']").first()).toContainText(
    "Archived",
  );
  const tab = page.getByTestId("leaving-tab");
  await expect(tab.getByRole("button")).toHaveCount(0);
  await expect(tab.locator("form")).toHaveCount(0);
  await checkBothThemes(page, "archived record, Leaving tab");
  // The people list marks the record as archived beside the name.
  await page.goto("/people");
  const row = main(page)
    .getByRole("row")
    .filter({ has: page.locator(`a[href='/people/${id}']`) });
  await expect(row.locator("[data-person-status='archived']")).toContainText("Archived");
}

test("hazard HZ-001 a planned discharge is worked through its checklist, returns and money to the archived record", async ({
  page,
  browser,
}, testInfo) => {
  test.setTimeout(240_000);
  await signIn(page, "manager@example.invalid");
  const { id } = await admit(page, "Dora");
  await holdPropertyAndKey(page, id);

  await openLeaving(page, id);
  await expect(main(page).getByText("Nothing is in progress.")).toHaveCount(0);
  await checkBothThemes(page, "Leaving tab, nothing in progress");

  // Plan the discharge, with the person's money held by the home.
  const plan = main(page).getByRole("form", { name: "Plan a discharge or transfer" });
  await plan.getByRole("button", { name: "Plan the exit" }).click();
  await expect(
    plan.getByText("Choose whether this is a discharge or a transfer.").first(),
  ).toBeVisible();
  await plan.getByRole("radio", { name: "Discharge" }).check();
  await plan.getByLabel("Where the person is going").selectOption("own_home");
  await plan.getByRole("checkbox", { name: "Personal money held by the home" }).check();
  await clickAndWait(page, plan.getByRole("button", { name: "Plan the exit" }), "Exit planned.");
  await expect(page.getByTestId("exit-summary")).toContainText("Planned");
  await checkBothThemes(page, "planned discharge");

  // The person leaves: a reason is needed.
  const left = main(page).getByRole("form", { name: "Record that the person has left" });
  await left.getByRole("button", { name: "Record that they have left" }).click();
  await expect(left.getByText("Say why the person is leaving.").first()).toBeVisible();
  await left.getByLabel("Reason for leaving").fill(`Going home with family support (${RUN}).`);
  await clickAndWait(
    page,
    left.getByRole("button", { name: "Record that they have left" }),
    "Leaving recorded.",
  );
  await expect(page.getByTestId("exit-summary")).toContainText("Left");
  // The header says the person has left, an icon and a word.
  await expect(main(page).locator("[data-person-status='discharged']").first()).toContainText(
    "Left the service",
  );
  await expect(main(page).getByRole("form", { name: "Record a death" })).toHaveCount(0);

  // One item is not required, with a reason; the rest are done.
  const involved = item(page, "The person and their representatives involved in the plan");
  await involved.getByRole("button", { name: /^Mark as not required: / }).click();
  await involved.getByRole("button", { name: "Save as not required" }).click();
  await expect(involved.getByText("Say why it is not required.").first()).toBeVisible();
  await involved
    .getByRole("textbox")
    .fill("The person planned this themselves with their daughter.");
  await clickAndWait(
    page,
    involved.getByRole("button", { name: "Save as not required" }),
    "Checklist updated.",
  );
  await expect(
    item(page, "The person and their representatives involved in the plan"),
  ).toContainText("Not required");
  await tickRemaining(page, /Personal money/);
  await checkBothThemes(page, "discharge checklist done before returns");

  // Money needs a fresh sign-in, then someone other than whoever recorded the exit.
  const money = item(page, "Personal money returned and the account closed");
  await money.getByRole("button", { name: /^Mark as done: / }).click();
  await expect(money.getByRole("alert")).toContainText("needs your passkey or authenticator code");
  await expectAccessible(page, "money return, step-up asked");

  await clickAndWait(
    page,
    main(page).getByRole("button", { name: "Wait for returns" }),
    "Now waiting for returns.",
  );
  await expect(page.getByTestId("exit-summary")).toContainText("Waiting for returns");
  await expect(page.getByTestId("exit-outstanding")).toContainText("Personal money returned");

  // Return the glasses and the key.
  const returns = main(page).getByRole("region", { name: "Property and keys to return" });
  await returns.getByRole("button", { name: /^Record the return: Reading glasses/ }).click();
  const form = returns.getByRole("form", { name: /^Return of Reading glasses/ });
  await form.getByRole("button", { name: "Save the return" }).click();
  await expect(form.getByText("Enter who received it.").first()).toBeVisible();
  await form.getByLabel("Who received it").fill("Dora Example");
  await form.getByLabel("Name of the person who signed").fill("Dora Example");
  await expectAccessible(page, "property return form");
  await clickAndWait(
    page,
    form.getByRole("button", { name: "Save the return" }),
    "Return recorded.",
  );
  await clickAndWait(
    page,
    returns.getByRole("button", { name: /^Returned today: Room key/ }),
    "Return recorded.",
  );
  await expect(returns).toContainText("Nothing is held");
  await expect(item(page, "Personal property returned or handed over")).toContainText("Done");
  await expect(item(page, "Keys and fobs returned or reported lost")).toContainText("Done");

  // The manager, with a fresh sign-in, recorded the exit: someone else must confirm the money.
  await page.context().clearCookies();
  await signInWithDemoPasskey(page, "manager");
  await openLeaving(page, id);
  await item(page, "Personal money returned and the account closed")
    .getByRole("button", { name: /^Mark as done: / })
    .click();
  await expect(main(page).getByRole("alert").first()).toContainText(
    "Someone other than the person who recorded the exit",
  );

  // The owner confirms it, closes the checklist and archives the record.
  // Their own browser: one passkey per browser, as on their own phone.
  const ownerContext = await browser.newContext({ baseURL: testInfo.project.use.baseURL });
  const owner = await ownerContext.newPage();
  await signInWithDemoPasskey(owner, "owner");
  await openLeaving(owner, id);
  await clickAndWait(
    owner,
    item(owner, "Personal money returned and the account closed").getByRole("button", {
      name: /^Mark as done: /,
    }),
    "Checklist updated.",
  );
  await clickAndWait(
    owner,
    main(owner).getByRole("button", { name: "Close the checklist" }),
    "Checklist closed.",
  );
  await expect(owner.getByTestId("exit-summary")).toContainText("Closed");
  await expect(main(owner).getByRole("button", { name: /^Mark as / })).toHaveCount(0);
  await checkBothThemes(owner, "closed discharge, ready to archive");
  await archive(owner);
  await expectArchived(owner, id);
  await ownerContext.close();
});

test("hazard HZ-001 a transfer to another provider is recorded at once and archived", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await signIn(page, "manager@example.invalid");
  const { id } = await admit(page, "Elsie");
  await openLeaving(page, id);

  const record = main(page).getByRole("form", { name: "Record a discharge or transfer" });
  await record.getByRole("radio", { name: "Transfer to another provider" }).check();
  await record.getByLabel("Where the person is going").selectOption("care_home");
  await record.getByLabel("Receiving provider").fill(`Example Nursing Home (${RUN})`);
  await record.getByLabel("Reason for leaving").fill("Needs nursing care closer to family.");
  await clickAndWait(
    page,
    record.getByRole("button", { name: "Record the discharge or transfer" }),
    "Leaving recorded.",
  );
  await expect(page.getByTestId("exit-summary")).toContainText("Transfer to another provider");
  await expect(page.getByTestId("exit-summary")).toContainText(`Example Nursing Home (${RUN})`);
  await expect(item(page, "Transfer of care summary sent")).toContainText(
    "before the person leaves",
  );
  await checkBothThemes(page, "transfer checklist");

  await tickRemaining(page, /^$/);
  await clickAndWait(
    page,
    main(page).getByRole("button", { name: "Wait for returns" }),
    "Now waiting for returns.",
  );
  await expect(
    main(page).getByRole("region", { name: "Property and keys to return" }),
  ).toContainText("Nothing is held");
  await clickAndWait(
    page,
    main(page).getByRole("button", { name: "Close the checklist" }),
    "Checklist closed.",
  );
  await archive(page);
  await expectArchived(page, id);
});

test("hazard HZ-013 a death drafts its notifications, which the checklist links to and follows, to the archived record", async ({
  page,
}) => {
  test.setTimeout(240_000);
  await signIn(page, "manager@example.invalid");
  const { id, roomId } = await admit(page, "Freda");
  await page.context().clearCookies();

  // The nurse records the death: whether expected and LeDeR are asked, never assumed.
  await signIn(page, "nurse@example.invalid");
  await openLeaving(page, id);
  await expect(main(page).getByRole("form", { name: "Plan a discharge or transfer" })).toHaveCount(
    0,
  );
  const death = main(page).getByRole("form", { name: "Record a death" });
  await death.getByRole("button", { name: "Record the death" }).click();
  await expect(death.getByText("Say whether the death was expected.").first()).toBeVisible();
  await expect(
    death.getByText("Answer whether the person had a learning disability or was autistic.").first(),
  ).toBeVisible();
  await expectAccessible(page, "record a death, answers missing");
  await death.getByRole("radio", { name: "No, it was unexpected" }).check();
  await death
    .getByRole("group", { name: /learning disability/ })
    .getByRole("radio", { name: "No" })
    .check();
  await death.getByLabel("Death verified by (name, optional)").fill("Example Paramedic");
  await death.getByRole("checkbox", { name: "Personal money held by the home" }).check();
  await clickAndWait(
    page,
    death.getByRole("button", { name: "Record the death" }),
    "Death recorded.",
  );
  await expect(page.getByTestId("exit-summary")).toContainText("Death");
  await expect(main(page).locator("[data-person-status='deceased']").first()).toContainText("Died");
  // An unexpected death asks for the coroner referral.
  await expect(item(page, /^Coroner referral recorded/)).toBeVisible();

  // The safety module drafts the notifications from the death (the worker's outbox relay, once).
  execFileSync("pnpm", ["outbox:run"], { cwd: API_DIR, stdio: "ignore" });
  await openLeaving(page, id);
  const regulator = item(page, "Death notification to the regulator");
  const examiner = item(page, "Information pack sent to the medical examiner");
  for (const entry of [regulator, examiner]) {
    await expect(entry).toContainText("Required by law");
    await expect(entry.getByRole("button")).toHaveCount(0);
  }
  await checkBothThemes(page, "death checklist with its notifications");
  const examinerLink = examiner.getByRole("link", { name: /^Open the notification: / });
  const examinerHref = (await examinerLink.getAttribute("href")) ?? "";
  const regulatorHref =
    (await regulator
      .getByRole("link", { name: /^Open the notification: / })
      .getAttribute("href")) ?? "";
  expect(examinerHref).toMatch(/^\/notifications\/statutory\/[0-9a-f-]{36}$/);
  await examinerLink.click();
  await page.waitForURL((url) => url.pathname === examinerHref);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

  // The nurse ticks what they may; moving on, the money and archiving are for managers.
  await openLeaving(page, id);
  await tickRemaining(page, /Personal money/);
  await expect(main(page).getByRole("button", { name: "Wait for returns" })).toHaveCount(0);
  await expect(
    main(page).getByRole("button", { name: /^Mark as done: Personal money/ }),
  ).toHaveCount(0);
  await page.context().clearCookies();

  // The manager decides the notifications (as they would on their own pages) with a fresh sign-in.
  await signInWithDemoPasskey(page, "manager");
  for (const href of [regulatorHref, examinerHref]) {
    const notification = href.split("/").pop() ?? "";
    const current = await call<{ version: number }>(
      page,
      "GET",
      `/v1/notifications/statutory/${notification}`,
    );
    await call(page, "POST", `/v1/notifications/statutory/${notification}/not-required`, {
      reason: `Journey ${RUN}: an invented person, nothing to send to anyone.`,
      version: current.version,
    });
  }
  await openLeaving(page, id);
  await expect(item(page, "Death notification to the regulator")).toContainText("Not required");
  await expect(item(page, "Information pack sent to the medical examiner")).toContainText(
    "Not required",
  );

  // The nurse recorded the death, so the manager may confirm the money.
  await clickAndWait(
    page,
    main(page).getByRole("button", { name: "Wait for returns" }),
    "Now waiting for returns.",
  );
  await clickAndWait(
    page,
    item(page, "Personal money returned and the account closed").getByRole("button", {
      name: /^Mark as done: /,
    }),
    "Checklist updated.",
  );
  await clickAndWait(
    page,
    main(page).getByRole("button", { name: "Close the checklist" }),
    "Checklist closed.",
  );
  await archive(page);
  await expectArchived(page, id);

  // The room held after the death is cleared, so the next run finds its beds free.
  const board = await call<{ rooms: { roomId: string; status: string; version: number }[] }>(
    page,
    "GET",
    `/v1/locations/${LOCATION}/beds`,
  );
  const held = board.rooms.find((r) => r.roomId === roomId);
  expect(held?.status).toBe("awaiting_clearance");
  await call(page, "POST", `/v1/rooms/${roomId}/clearance`, {
    on: ukToday(),
    version: held?.version,
  });
});
