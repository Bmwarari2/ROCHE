import { expect, type Page, test } from "@playwright/test";
import { expectAccessible, signIn, signInWithDemoPasskey } from "./support";

/**
 * The DSAR workbench (PLAT-022; platform.md, the DSAR workbench; slice 66). In the demo tenant
 * the owner, signed in with the end-to-end passkey (a fresh step-up), records a request for a
 * person supported, confirms who is asking, pauses and restarts the clock, finds the records with
 * what was not searched named first, and takes a part out of one record with a reason. In the
 * starter organisation, which holds almost nothing, the starter owner follows a request about
 * themselves through to the response. The Registered Manager, who holds the permission for one
 * home only, is not offered the screens. Every state is checked with axe in light and dark.
 */

test.describe.configure({ mode: "serial" });

const main = (page: Page) => page.getByRole("main");
const region = (page: Page, name: string | RegExp) => page.getByRole("region", { name });

async function accessible(page: Page, name: string) {
  await page.emulateMedia({ colorScheme: "light" });
  await expectAccessible(page, name);
  await page.emulateMedia({ colorScheme: "dark" });
  await expectAccessible(page, `${name} (dark)`);
  await page.emulateMedia({ colorScheme: "light" });
}

/** The arrival after a save: a status saying what was done. */
async function arrived(page: Page, words: string | RegExp) {
  await expect(main(page).getByRole("status").filter({ hasText: words })).toBeVisible();
}

async function recordRequest(page: Page, subject: "Person we support" | "Member of staff") {
  await page.goto("/data-rights");
  await expect(page.getByRole("heading", { level: 1, name: "Data rights requests" })).toBeVisible();
  const form = region(page, "Record a request");
  await form.getByRole("radio", { name: subject }).check();
  const who = form.getByRole("combobox", { name: subject });
  await who.selectOption({ index: 1 });
  return form;
}

test("a manager for one home is not offered the data rights screens", async ({ page }) => {
  await signIn(page, "manager@example.invalid");
  await expect(
    page.getByRole("navigation", { name: "Modules" }).getByRole("link", { name: "Data rights" }),
  ).toHaveCount(0);
  await page.goto("/data-rights/requests");
  await expect(main(page).getByText("Only people who look after data protection")).toBeVisible();
});

test("the owner records a request, starts the clock and reviews a record", async ({ page }) => {
  test.setTimeout(180_000);
  await signInWithDemoPasskey(page, "owner");
  await expect(
    page.getByRole("navigation", { name: "Modules" }).getByRole("link", { name: "Data rights" }),
  ).toBeVisible();
  const form = await recordRequest(page, "Person we support");
  await accessible(page, "data rights requests");
  await form.getByRole("button", { name: "Record the request" }).click();
  await arrived(page, "The request is recorded.");
  await expect(main(page).getByText("Clock not started")).toBeVisible();
  await accessible(page, "a new request");

  const identity = region(page, "1. Confirm who is asking");
  await identity.getByLabel("How you confirmed it").selectOption({ label: "staff know them" });
  await identity.getByRole("button", { name: "Confirm and start the clock" }).click();
  await arrived(page, "Identity confirmed. The clock has started.");
  await expect(region(page, /^Clock$/).getByText(/^Respond by \d{2}\/\d{2}\/\d{4}/)).toBeVisible();

  const pause = region(page, "Pause or extend the clock");
  await pause.getByRole("button", { name: "Pause the clock" }).click();
  await arrived(page, "The clock is paused.");
  await expect(region(page, /^Clock$/).getByText("Paused", { exact: true })).toBeVisible();
  await region(page, "Pause or extend the clock")
    .getByRole("button", { name: "Restart the clock" })
    .click();
  await arrived(page, "The clock has restarted.");

  await region(page, "2. Find the records")
    .getByRole("button", { name: "Find the records" })
    .click();
  await arrived(page, "The records have been collected.");
  const review = region(page, "3. Review each record");
  await expect(review).toBeVisible();
  await accessible(page, "collected records");

  await review
    .getByRole("link", { name: /^Review / })
    .first()
    .click();
  await expect(page.getByRole("heading", { level: 1, name: "Review a record" })).toBeVisible();
  await expect(region(page, "Other people named")).toBeVisible();
  await accessible(page, "a record to review");
  const decision = region(page, "Your decision");
  await decision.getByRole("radio", { name: "Send it with parts taken out" }).check();
  await decision
    .getByRole("group", { name: "Parts to take out" })
    .getByRole("checkbox")
    .first()
    .check();
  await decision.getByLabel("Reason").fill("It names another person supported (third-party data).");
  await accessible(page, "a redaction decision");
  await decision.getByRole("button", { name: "Save the decision" }).click();
  await arrived(page, "Your decision on the record is saved.");
  await expect(
    region(page, "3. Review each record").getByText("Send with parts taken out").first(),
  ).toBeVisible();
});

test("the starter owner follows a request about themselves to the response", async ({ page }) => {
  test.setTimeout(240_000);
  await signInWithDemoPasskey(page, "starter");
  const form = await recordRequest(page, "Member of staff");
  await form.getByLabel("We need to confirm who is asking before we respond").uncheck();
  await form.getByRole("button", { name: "Record the request" }).click();
  await arrived(page, "The request is recorded.");
  await expect(main(page).getByText("You recorded that you did not need to confirm")).toBeVisible();

  await region(page, "2. Find the records")
    .getByRole("button", { name: "Find the records" })
    .click();
  await arrived(page, "The records have been collected.");

  // Decide every record in turn: the starter organisation holds only a handful.
  for (let i = 0; i < 40; i += 1) {
    const row = region(page, "3. Review each record")
      .getByRole("row")
      .filter({ hasText: "To review" })
      .first();
    if ((await row.count()) === 0) break;
    await row.getByRole("link", { name: /^Review / }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Review a record" })).toBeVisible();
    await region(page, "Your decision").getByRole("radio", { name: "Send it as it is" }).check();
    await region(page, "Your decision").getByRole("button", { name: "Save the decision" }).click();
    await arrived(page, "Your decision on the record is saved.");
  }
  await expect(
    region(page, "3. Review each record").getByRole("row").filter({ hasText: "To review" }),
  ).toHaveCount(0);

  await region(page, "4. Send the response")
    .getByRole("link", { name: "Check the response and send it" })
    .click();
  await expect(page.getByRole("heading", { level: 1, name: "Check the response" })).toBeVisible();
  await expect(main(page).getByText(/^Fingerprint \(SHA-256\): [0-9a-f]{64}$/)).toBeVisible();
  await expect(
    main(page).getByRole("link", { name: "Download the response to send" }),
  ).toBeVisible();
  await accessible(page, "the response to check");
  const respond = region(page, "Record the response");
  await respond.getByLabel("Outcome").selectOption({ label: "Sent in full" });
  await respond.getByRole("button", { name: "Record the response and close the request" }).click();
  await arrived(page, "The response is recorded and the request is closed.");
  await expect(region(page, /^Response$/).getByText(/^Sent in full, on/)).toBeVisible();
  await expect(
    main(page).getByRole("link", { name: "Download exactly what was sent" }),
  ).toBeVisible();
  await accessible(page, "a closed request");
});
