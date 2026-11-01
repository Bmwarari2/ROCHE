import { randomUUID } from "node:crypto";
import { type Browser, expect, type Page, test } from "@playwright/test";
import { demoPerson, expectAccessible, signInWithDemoPasskey } from "./support";

/**
 * The controlled drugs register (MEDS-005, MEDS-014; medicines.md section 15) against the demo
 * tenant, on Frank's morphine (seed-users.ts gives it dm+d's controlled drug schedule, which slice
 * 10 will set). The owner signs first as witness, in their own session, for what they saw and
 * whom they watched; the manager records with that signature: a receipt, a correction of a detail
 * under the entry it corrects, and a count that does not match, which raises an incident. The print
 * view shows every entry with its signatures. Both step up with the end-to-end passkey. Each state
 * is checked with axe in light and dark. Every run adds to the same page, so it can run again.
 */

const FRANK = demoPerson(6);
const RUN = randomUUID().slice(0, 8);
const PRODUCT = "Morphine sulfate 10mg tablets";
const OWNER = "Olive Owner";
const MANAGER = "Mo Manager";

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

async function signedIn(browser: Browser, who: "manager" | "owner"): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await signInWithDemoPasskey(page, who);
  return page;
}

/** The owner signs, as witness, for what they saw the manager do. */
async function witnessSigns(owner: Page, url: string, what: string, quantity: string) {
  await owner.goto(url);
  const sign = region(owner, "Sign as witness");
  await sign.getByLabel("What you saw").selectOption({ label: what });
  await sign.getByLabel(/^How much, in/).fill(quantity);
  await sign.getByLabel("Who you watched record it").selectOption({ label: MANAGER });
  await sign.getByRole("button", { name: "Sign as witness" }).click();
  await expect(status(owner, /Signed as witness\./)).toBeVisible();
}

test("hazard HZ-115 hazard HZ-116 a witnessed receipt, a correction and a count that does not match, then printed", async ({
  browser,
}) => {
  test.setTimeout(300_000);
  const manager = await signedIn(browser, "manager");
  await manager.goto(`/people/${FRANK}/controlled-drugs`);
  await expect(
    main(manager).getByRole("heading", { level: 2, name: "Controlled drugs register" }),
  ).toBeVisible();
  // Open Frank's morphine page, or go to it when an earlier run opened it.
  const link = main(manager).getByRole("link", { name: PRODUCT });
  if ((await link.count()) === 0) {
    const open = region(manager, "Open a register page");
    await open.getByLabel("Medicine on the MAR chart").selectOption({ label: PRODUCT });
    await open.getByRole("button", { name: "Open the register page" }).click();
    await manager.waitForURL(/\/controlled-drugs\/[0-9a-f-]{36}/);
  } else {
    await bothThemes(manager, "controlled drugs tab");
    await link.click();
    await manager.waitForURL(/\/controlled-drugs\/[0-9a-f-]{36}/);
  }
  const url = manager.url().split("?")[0] ?? "";
  await expect(main(manager).getByText("In stock:").first()).toBeVisible();
  // Nothing to record with until a witness signs.
  await expect(region(manager, "Record a movement")).toContainText(
    "No witness has signed for you on this page yet.",
  );
  await bothThemes(manager, "register page");

  // Witness first: the owner signs for a receipt of 10 they watched the manager take in.
  const owner = await signedIn(browser, "owner");
  await witnessSigns(owner, url, "Received", "10");
  await bothThemes(owner, "signed as witness");

  // The manager records it, choosing the owner's signature.
  await manager.goto(url);
  const record = region(manager, "Record a movement");
  await record.getByLabel("What happened").selectOption({ label: "Received" });
  await record.getByLabel(/^How much, in/).fill("10");
  await record.getByLabel("From or to").fill("Example Pharmacy");
  await record.getByLabel("Reference").fill(`Delivery ${RUN}`);
  await record.getByRole("radio", { name: new RegExp(`^${OWNER}: Received, 10`) }).check();
  await record.getByRole("button", { name: "Record it" }).click();
  await expect(status(manager, "Recorded on the register.")).toBeVisible();
  const entries = region(manager, "Entries");
  const received = entries.getByRole("listitem").filter({ hasText: `Delivery ${RUN}` });
  await expect(received).toContainText(`Witness${OWNER}`);
  const seq = ((await received.getByText(/^Entry \d+$/).textContent()) ?? "").replace("Entry ", "");
  await bothThemes(manager, "receipt recorded");

  // A correction of a detail, witnessed, sits under the entry it corrects.
  await witnessSigns(owner, url, "A correction", "0");
  await manager.goto(url);
  const correct = region(manager, "Correct an entry");
  const option = await correct
    .getByLabel("Entry to correct")
    .locator("option", { hasText: new RegExp(`^Entry ${seq}:`) })
    .getAttribute("value");
  await correct.getByLabel("Entry to correct").selectOption(option ?? "");
  await correct.getByRole("radio", { name: /A detail/ }).check();
  await correct.getByLabel("What was wrong").fill(`The delivery note was ${RUN}-B`);
  await correct.getByRole("radio", { name: new RegExp(`^${OWNER}: A correction`) }).check();
  await correct.getByRole("button", { name: "Record the correction" }).click();
  await expect(status(manager, "Correction recorded under the entry it corrects.")).toBeVisible();
  await expect(main(manager).getByText(`Corrects entry ${seq}: a detail`).first()).toBeVisible();
  await bothThemes(manager, "correction recorded");

  // A count that does not match needs a reason, and raises an incident.
  await witnessSigns(owner, url, "A stock count", "0");
  await manager.goto(url);
  const count = region(manager, "Count the stock");
  await count.getByLabel(/^How many you counted/).fill("0");
  await count.getByLabel("If it does not match, why").fill(`Cupboard found empty, run ${RUN}`);
  await count.getByRole("radio", { name: new RegExp(`^${OWNER}: A stock count`) }).check();
  await count.getByRole("button", { name: "Record the count" }).click();
  await expect(status(manager, /a medication incident has been raised/)).toBeVisible();
  await expect(region(manager, "Stock counts")).toContainText(`Cupboard found empty, run ${RUN}`);
  await bothThemes(manager, "count that does not match");

  // The print view: every entry with its signatures and corrections.
  await main(manager).getByRole("link", { name: "Print this page" }).click();
  await manager.waitForURL(/\/print$/);
  await expect(
    manager.getByRole("heading", { level: 1, name: `Controlled drugs register: ${PRODUCT}` }),
  ).toBeVisible();
  await expect(manager.getByRole("main")).toContainText(`Delivery ${RUN}`);
  await expect(manager.getByRole("main")).toContainText(`Corrects entry ${seq}: a detail`);
  await bothThemes(manager, "print view");
  await owner.context().close();
  await manager.context().close();
});
