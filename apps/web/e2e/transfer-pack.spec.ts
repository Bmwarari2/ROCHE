import { readFile } from "node:fs/promises";
import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import { demoPerson, expectAccessible, signIn } from "./support";

/**
 * The hospital transfer pack on the web (PEOP-009; people.md rule 10 and section 6a; HZ-001,
 * HZ-023) against the demo tenant, as the demo nurse (clinical lead: people.movement.record and
 * care.plan.write). Each run sends Frank (resident 6) to a hospital named with the run, prints the
 * pack, records the hand-over and the return, and does every check on return, so Frank is back
 * home and nothing is left open afterwards. A run that stopped half-way is finished first.
 */

const PERSON = demoPerson(6);
const RUN = `run ${Date.now().toString(36)}`;
const HOSPITAL = `Example General Hospital (${RUN})`;
const TAB = `/people/${PERSON}/hospital`;

test.describe.configure({ mode: "serial" });

let session: Awaited<ReturnType<BrowserContext["cookies"]>> = [];

test.beforeAll(async ({ browser }, testInfo) => {
  const context = await browser.newContext({ baseURL: testInfo.project.use.baseURL });
  const page = await context.newPage();
  await signIn(page, "nurse@example.invalid");
  session = await context.cookies();
  await context.close();
});

test.beforeEach(async ({ context }) => {
  await context.addCookies(session);
});

const card = (page: Page, title: string | RegExp) => page.getByRole("region", { name: title });

async function bothThemes(page: Page, name: string) {
  await expectAccessible(page, name);
  await page.emulateMedia({ colorScheme: "dark" });
  await expectAccessible(page, `${name}, dark theme`);
  await page.emulateMedia({ colorScheme: "light" });
}

/** What the page says once a write lands, and that it has focus (WCAG 2.4.3 and 4.1.3). */
async function arrived(page: Page, text: string) {
  const notice = page.locator("[data-arrival-notice]");
  await expect(notice).toHaveText(text);
  await expect(notice).toBeFocused();
}

/** Does every check on return still open, so Frank's record is left as the run found it. */
async function finishChecks(page: Page) {
  const checks = card(page, "Checks on return");
  while ((await checks.count()) > 0) {
    const button = checks.getByRole("button", { name: /^Mark as done: / }).first();
    if ((await button.count()) === 0) break;
    const name = (await button.getAttribute("aria-label")) ?? "";
    await button.click();
    await expect(checks.getByRole("button", { name, exact: true })).toHaveCount(0);
    await arrived(page, "Check recorded.");
  }
}

/** A run that stopped with Frank still in hospital is finished before this one starts. */
async function startAtHome(page: Page) {
  await page.goto(TAB);
  const back = page.getByRole("button", { name: "Record the return" });
  if (await back.isVisible()) {
    await back.click();
    await arrived(page, "Return recorded. The checks on return are below.");
  }
  await finishChecks(page);
}

test("hazards HZ-001 and HZ-023 the pack as it would be made now names the person and shows what is missing", async ({
  page,
}) => {
  await startAtHome(page);
  const header = page.getByRole("heading", { level: 1 });
  await expect(header).toHaveText("Frank Dummy");
  const preview = card(page, "The pack as it would be made now");
  // The pack's own identity, the same person as the header (HZ-001).
  await expect(preview.locator("[data-pack-name]")).toHaveText("Frank Dummy");
  await expect(preview.locator("[data-pack-dob]")).toHaveText("25/01/1946");
  await expect(preview.locator("[data-pack-nhs]")).toHaveText("999 000 0069");
  // When the pack was made, and that it is made again on sending (HZ-002, HZ-023).
  await expect(preview.locator("[data-pack-made]")).toContainText(
    /^Made at \d{2}\/\d{2}\/\d{4}.*The pack is made again/,
  );
  // Missing safety-critical sections read "Not recorded", listed first and never blank (HZ-023).
  await expect(preview.locator("[data-pack-missing]")).toContainText(
    /safety-critical sections? (is|are) not recorded/,
  );
  const communication = preview.locator('[data-pack-section="communication"]');
  await expect(communication).toHaveAttribute("data-pack-status", "not_recorded");
  await expect(communication).toContainText("Not recorded");
  await expect(preview.locator("[data-pack-section]").first()).toHaveAttribute(
    "data-pack-status",
    "not_recorded",
  );
  await expect(preview.locator('[data-pack-section="allergies"]')).toContainText("Included");
  await bothThemes(page, "hospital tab, pack before sending");
});

test("hazard HZ-023 sends the person with the pack in one form, prints it and records an incomplete hand-over only with a reason", async ({
  page,
}) => {
  await startAtHome(page);
  const send = card(page, "Send to hospital");
  // The hospital is the only thing that must be typed.
  await send.getByRole("button", { name: "Send to hospital and make the pack" }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "Enter the name of the hospital" }),
  ).toBeFocused();
  await send.getByLabel("Hospital", { exact: true }).fill(HOSPITAL);
  await send.getByRole("button", { name: "Send to hospital and make the pack" }).click();
  await arrived(page, "Pack made. Print it and send it with the person.");

  const away = card(page, `Sent to ${HOSPITAL}`);
  await expect(away.locator("[data-pack-name]")).toHaveText("Frank Dummy");
  await expect(away.locator("[data-pack-nhs]")).toHaveText("999 000 0069");

  // The printable PDF downloads as a PDF, named for the transfer, never kept by the web app.
  const download = page.waitForEvent("download");
  await away.getByRole("link", { name: "Print the transfer pack (PDF)" }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^transfer-pack-[0-9a-f-]{36}\.pdf$/);
  const bytes = await readFile(await file.path());
  expect(bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");

  await bothThemes(page, "hospital tab, pack sent");

  // An incomplete pack's hand-over needs the named acknowledgement and a reason (HZ-023).
  await expect(away.getByText(/missing safety-critical information/)).toBeVisible();
  await away.getByRole("button", { name: "Record the hand-over" }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "Say why the pack is going" }),
  ).toBeFocused();
  await away
    .getByLabel("Why is the pack going as it is?")
    .fill(`Emergency; communication needs being confirmed with the family (${RUN})`);
  await away.getByRole("button", { name: "Record the hand-over" }).click();
  await arrived(page, "Hand-over recorded.");
  await expect(card(page, `Sent to ${HOSPITAL}`).locator("[data-pack-handed-over]")).toBeVisible();
  await expect(card(page, `Sent to ${HOSPITAL}`)).toContainText(`Reason given: Emergency;`);
});

test("hazard HZ-023 records the return, sets the checks on return and keeps the pack to print again", async ({
  page,
}) => {
  await page.goto(TAB);
  await card(page, "Return from hospital")
    .getByRole("button", { name: "Record the return" })
    .click();
  await arrived(page, "Return recorded. The checks on return are below.");
  const checks = card(page, "Checks on return");
  await expect(checks.locator('[data-return-check="medicines_reconciled"]')).toContainText("To do");
  await expect(checks.locator('[data-return-check="allergies_rechecked"]')).toContainText("To do");
  await bothThemes(page, "hospital tab, checks on return");
  await checks
    .getByRole("button", { name: "Mark as done: Skin checked and body map updated" })
    .click();
  await expect(page.locator("[data-arrival-notice]")).toHaveText("Check recorded.");
  await expect(page.locator("[data-arrival-notice]")).toBeFocused();
  await expect(
    card(page, "Checks on return").locator('[data-return-check="skin_checked"]'),
  ).toContainText("Done");
  await finishChecks(page);

  // The pack as sent stays printable from the earlier transfers.
  const earlier = card(page, "Earlier transfers").getByRole("listitem").filter({ hasText: RUN });
  await expect(earlier.getByRole("link", { name: /^Print the pack sent on / })).toBeVisible();
  // Back home: the pack as it would be made now is offered again.
  await expect(card(page, "The pack as it would be made now")).toBeVisible();
});
