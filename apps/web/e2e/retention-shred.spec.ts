import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { type APIRequestContext, type Browser, expect, type Page, test } from "@playwright/test";
import { type DemoPasskeyHolder, expectAccessible, signInWithDemoPasskey } from "./support";

/**
 * Shredding the whole organisation's records (PLAT-012 part 2; platform.md, Crypto-shredding
 * screens rules 7 to 12) in Closing Example Care (seed-users.ts), an invented organisation used
 * only by this journey, so approving never touches the demo organisation's documents. Cass
 * Closing asks; Remy Records refuses with a reason; Cass asks again; Remy approves after typing
 * the word and acknowledging it; the certificate opens with its signature checked, downloads as a
 * PDF and shows its check as data. Each step is checked with axe in light and dark. The seed
 * records a full export as downloaded when it runs, so this runs within 30 days of seeding.
 */

const API_URL = process.env.API_URL ?? "http://localhost:4000";
const CLOSING_TENANT = "0194f200-0000-7000-8000-000000000001";
const RUN = randomUUID().slice(0, 8);
const REASON = `Contract ended and the full export was taken, run ${RUN}`;
const PAGE = "/settings/retention/shred";

test.describe.configure({ mode: "serial" });

const main = (page: Page) => page.getByRole("main");
const region = (page: Page, name: string) => main(page).getByRole("region", { name });
const status = (page: Page, words: string | RegExp) =>
  main(page).getByRole("status").filter({ hasText: words });

async function bothThemes(page: Page, name: string) {
  await expectAccessible(page, `${name} (light)`);
  await page.emulateMedia({ colorScheme: "dark" });
  await expectAccessible(page, `${name} (dark)`);
  await page.emulateMedia({ colorScheme: "light" });
}

async function signedIn(browser: Browser, who: DemoPasskeyHolder): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await signInWithDemoPasskey(page, who);
  return page;
}

/** Withdraws or cancels a request an earlier, interrupted run left open, so a new one can be made. */
async function closeLeftovers(request: APIRequestContext) {
  const headers = { "x-harbour-tenant": CLOSING_TENANT };
  const listed = await request.get(`${API_URL}/v1/retention/shred-requests`, { headers });
  expect(listed.ok()).toBe(true);
  const { items } = (await listed.json()) as { items: { id: string; status: string }[] };
  for (const open of items.filter((i) => i.status === "pending")) {
    await request.post(`${API_URL}/v1/retention/shred-requests/${open.id}/cancel`, { headers });
  }
}

async function ask(page: Page) {
  await page.goto(PAGE);
  const form = region(page, "Ask for a shred");
  await form.getByLabel("Full export this shred follows").selectOption({ index: 1 });
  await form.getByLabel("Why the records are to be shredded").fill(REASON);
  await form.getByLabel("I understand this cannot be undone").check();
  await form.getByRole("button", { name: "Ask for the shred" }).click();
  await expect(status(page, "Shred asked for.")).toBeVisible();
  // Focus lands on the heading, which carries the outcome.
  await expect(page.getByRole("heading", { level: 1 })).toBeFocused();
  return page.url().split("?")[0] ?? "";
}

test("a shred is asked for, refused by a second person, asked again, approved and certified", async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const cass = await signedIn(browser, "closing");
  await closeLeftovers(cass.request);

  // From records retention, what a shred does comes first.
  await cass.goto("/settings/retention");
  await region(cass, "Destroy the organisation's stored files")
    .getByRole("link", { name: "Go to destroying stored files" })
    .click();
  await expect(
    cass.getByRole("heading", { level: 1, name: "Destroy the organisation's stored files" }),
  ).toBeVisible();
  const what = region(cass, "What a shred does");
  await expect(what).toContainText("Destroying the stored files cannot be undone.");
  await expect(what).toContainText("Care records in Harbour are not removed by this.");
  await bothThemes(cass, "shred page");

  // Nothing chosen, no reason, no acknowledgement: each said at its field.
  const form = region(cass, "Ask for a shred");
  await form.getByRole("button", { name: "Ask for the shred" }).click();
  await expect(form.getByText("Choose the full export this shred follows.").first()).toBeVisible();
  await expect(form.getByText("Give the reason in 20 to 1,000 characters.").first()).toBeVisible();
  await form.getByRole("heading", { name: "Ask for a shred" }).scrollIntoViewIfNeeded();
  await cass.evaluate(() => window.scrollBy(0, -80));
  await bothThemes(cass, "shred request errors");

  const first = await ask(cass);
  await expect(main(cass)).toContainText("Waiting for approval");
  await expect(main(cass)).toContainText(
    "You asked for this shred, so a different person must approve or refuse it.",
  );
  await expect(region(cass, "Approve the shred")).toHaveCount(0);
  await bothThemes(cass, "shred asked for");

  // Remy refuses it, with a reason.
  const remy = await signedIn(browser, "closingRecords");
  await remy.goto(first);
  const refuse = region(remy, "Refuse the shred");
  await refuse.getByRole("button", { name: "Refuse the shred" }).click();
  await expect(refuse.getByText("Give the reason in 10 to 500 characters.").first()).toBeVisible();
  await refuse.getByLabel("Why you are refusing it").fill("The board has not agreed it yet");
  await refuse.getByRole("button", { name: "Refuse the shred" }).click();
  await expect(status(remy, "Shred refused.")).toBeVisible();
  await expect(remy.getByRole("heading", { level: 1 })).toBeFocused();
  const about = region(remy, "About this request");
  await expect(about).toContainText("Refused");
  await expect(about).toContainText("The board has not agreed it yet");
  await expect(about).toContainText("Remy Records");
  await bothThemes(remy, "shred refused");

  // Asked again; Remy approves after the consequences, the typed word and the acknowledgement.
  const second = await ask(cass);
  await remy.goto(second);
  const approve = region(remy, "Approve the shred");
  await expect(approve).toContainText("Closing Example Care stops opening now");
  await approve.getByLabel("Type shred to confirm").fill("shed");
  await approve.getByRole("button", { name: "Approve the shred" }).click();
  await expect(approve.getByText("Type the word shred to confirm.").first()).toBeVisible();
  await expect(
    approve.getByText("Tick to confirm you understand this cannot be undone.").first(),
  ).toBeVisible();
  await bothThemes(remy, "approval errors");
  // Any case will do.
  await approve.getByLabel("Type shred to confirm").fill("Shred");
  await approve.getByLabel("I understand this cannot be undone").check();
  await approve.getByRole("button", { name: "Approve the shred" }).click();
  await expect(status(remy, /Shred approved\./)).toBeVisible();
  await expect(region(remy, "About this request")).toContainText("Shredded");
  await bothThemes(remy, "shred approved");

  // The certificate: its signature checked, as a PDF, and its check as data.
  await region(remy, "About this request")
    .getByRole("link", { name: "Open the destruction certificate" })
    .click();
  await expect(
    remy.getByRole("heading", { level: 1, name: "Destruction certificate" }),
  ).toBeVisible();
  await expect(region(remy, "Signature check")).toContainText("Signature checked");
  const states = region(remy, "What the certificate states");
  await expect(states).toContainText(REASON);
  await expect(states).toContainText("Database backups hold the deleted records until");
  await bothThemes(remy, "destruction certificate");
  const [download] = await Promise.all([
    remy.waitForEvent("download"),
    region(remy, "Signature check")
      .getByRole("link", { name: "Download the certificate as a PDF" })
      .click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/^destruction-certificate-[0-9a-f-]{36}\.pdf$/);
  const bytes = await readFile((await download.path()) ?? "");
  expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");
  const href = await region(remy, "Details for checking the signature")
    .getByRole("link", { name: /View the signature check/ })
    .getAttribute("href");
  const checked = await remy.request.get(href ?? "");
  expect(checked.ok()).toBe(true);
  expect(await checked.json()).toMatchObject({ valid: true });

  // A PDF that could not be made is said in an alert that takes focus.
  await remy.goto(`${remy.url().split("?")[0]}?pdf=failed`);
  const alert = main(remy).getByRole("alert");
  await expect(alert).toContainText("Sorry, the PDF could not be made. Try again.");
  await expect(alert).toBeFocused();
  await bothThemes(remy, "certificate PDF failed");

  // Listed on records retention, linked to the certificate.
  await remy.goto("/settings/retention");
  await expect(
    region(remy, "Destruction certificates")
      .getByRole("link", {
        name: /The organisation's stored records shredded/,
      })
      .first(),
  ).toBeVisible();
  await cass.context().close();
  await remy.context().close();
});
