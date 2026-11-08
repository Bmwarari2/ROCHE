import { randomUUID } from "node:crypto";
import { type Browser, expect, type Page, test } from "@playwright/test";
import { expectAccessible, signInWithDemoPasskey } from "./support";

/**
 * Doses recorded twice, and correcting a dose record, on the web (HZ-004; medicines.md 15.4 and
 * 14.4), against the demo seed's three conflicts on Frank Dummy's MAR (seed-users.ts). The phone
 * sends staff here to decide a controlled drug's conflict, to correct a record that is itself
 * wrong, and to correct a controlled drug's record with a witness. The manager decides that the
 * first record stands; corrects a refused dose that was in fact given, then decides it was
 * corrected; and corrects a controlled drug's dose, the owner signing as witness in their own
 * session from the link the page gives. The manager, having made that correction, may not decide
 * it; the owner does. Each screen is checked with axe in light and dark. The seed's conflicts are
 * resolved, so a rerun needs a fresh database.
 */

const DEMO_LOCATION = "0194d000-0000-7000-8000-000000000101";
const FRANK = "0194d000-0000-7000-8600-000000000006";
const PARACETAMOL = "Paracetamol 500mg tablets";
const OXYCODONE = "Oxycodone 5mg capsules";
const OWNER = "Olive Owner";
const RUN = randomUUID().slice(0, 8);

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

/** Opens the home's doses recorded twice from its medicines round. */
async function openConflicts(page: Page) {
  await page.goto(`/medicines-round/${DEMO_LOCATION}`);
  await main(page).getByRole("link", { name: "Doses recorded twice" }).click();
  await expect(
    main(page).getByRole("heading", { level: 1, name: "Doses recorded twice" }),
  ).toBeVisible();
}

/** Opens one dose's page, by its medicine and words on its card. */
async function openConflict(page: Page, medicine: string, words: string) {
  const card = main(page)
    .getByRole("article")
    .filter({ hasText: words })
    .filter({ hasText: medicine });
  await card
    .first()
    .getByRole("link", {
      name: new RegExp(`^Review and decide: ${medicine} for Frank Dummy, due `),
    })
    .click();
  await expect(
    main(page).getByRole("heading", { level: 1, name: `${medicine}: recorded twice` }),
  ).toBeVisible();
}

test("hazard HZ-004 the nurse in charge decides a dose sent twice: the first record stands", async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const manager = await signedIn(browser, "manager");
  await openConflicts(manager);
  await expect(main(manager).getByRole("article")).toHaveCount(3);
  await bothThemes(manager, "doses recorded twice");
  await openConflict(manager, PARACETAMOL, "Both records say the same thing");
  await expect(main(manager).getByText("The same member recorded both.")).toHaveCount(0);
  await expect(main(manager).getByText("Two different members recorded them.")).toBeVisible();
  const decide = region(manager, "Decide what happened");
  // Saying nothing is refused in words, at the fields.
  // No decision is chosen for the reader.
  for (const radio of await decide.getByRole("radio").all()) await expect(radio).not.toBeChecked();
  await decide.getByRole("button", { name: "Save decision" }).click();
  // The error summary takes focus, so it is heard first.
  await expect(decide.getByRole("alert")).toBeFocused();
  await expect(decide.getByText("Choose what happened.").first()).toBeVisible();
  await bothThemes(manager, "decision with errors");
  // By keyboard only: "given twice" asks again, and the question takes focus.
  const given = decide.getByRole("radio", { name: /The dose was given twice/ });
  await given.focus();
  await manager.keyboard.press("Space");
  await expect(given).toBeChecked();
  await decide.getByLabel("What you found out").focus();
  await manager.keyboard.type(`Checked with both staff, run ${RUN}`);
  await decide.getByRole("button", { name: "Save decision" }).focus();
  await manager.keyboard.press("Enter");
  const asked = decide.locator("[aria-live=assertive]");
  await expect(asked).toContainText(/raises a medication incident\.$/);
  await expect(asked).toBeFocused();
  await bothThemes(manager, "given twice asked again");
  await decide.getByRole("button", { name: "Keep reviewing" }).press("Enter");
  // The button goes, so focus returns to the question.
  await expect(decide.getByRole("radio").first()).toBeFocused();
  const stands = decide.getByRole("radio", { name: /the first record stands/ });
  await stands.focus();
  await manager.keyboard.press("Space");
  await expect(stands).toBeChecked();
  await decide.getByRole("button", { name: "Save decision" }).press("Enter");
  await expect(status(manager, "Decision saved")).toBeVisible();
  await expect(main(manager).getByRole("article")).toHaveCount(2);
});

test("hazard HZ-004 the record that stands is wrong: it is corrected, then the dose decided", async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const manager = await signedIn(browser, "manager");
  await openConflicts(manager);
  await openConflict(manager, PARACETAMOL, "The records differ");
  // The phone said given and the record that stands does not: correct it first.
  await expect(
    main(manager).getByText(/Correct the record that stands first, then decide\./),
  ).toBeVisible();
  await bothThemes(manager, "dose to correct first");
  await main(manager).getByRole("link", { name: "Correct the record that stands" }).click();
  await expect(
    main(manager).getByRole("heading", { name: `Correct a record of ${PARACETAMOL}` }),
  ).toBeVisible();
  await expect(
    main(manager)
      .getByText(/^Refused/)
      .first(),
  ).toBeVisible();
  const form = main(manager).locator("form");
  await form.getByRole("radio", { name: "Given", exact: true }).check();
  await form.getByLabel(/^Amount given, in/).fill("1");
  await form.getByRole("button", { name: "Save correction" }).click();
  await expect(form.getByRole("alert")).toBeFocused();
  await expect(form.getByText("Say why you are correcting it.").first()).toBeVisible();
  await bothThemes(manager, "correction with errors");
  await form
    .getByLabel("Why you are correcting it")
    .fill(`Refused was chosen by mistake, run ${RUN}`);
  await form.getByRole("button", { name: "Save correction" }).click();
  await expect(status(manager, "Record corrected. Now decide what happened.")).toBeVisible();
  // The record replaced is struck through beside the correction.
  await expect(
    main(manager)
      .locator("del")
      .filter({ hasText: /^Refused/ }),
  ).toBeVisible();
  const decide = region(manager, "Decide what happened");
  await expect(decide.getByRole("radio", { name: /has been corrected/ })).not.toBeChecked();
  await decide.getByRole("radio", { name: /has been corrected/ }).check();
  await decide
    .getByLabel("What you found out")
    .fill(`The carer confirmed it was given, run ${RUN}`);
  await bothThemes(manager, "decide after correcting");
  await decide.getByRole("button", { name: "Save decision" }).click();
  await expect(status(manager, "Decision saved")).toBeVisible();
});

test("hazard HZ-004 hazard HZ-115 a controlled drug's record is corrected with a witness, and decided by someone else", async ({
  browser,
}) => {
  test.setTimeout(300_000);
  const manager = await signedIn(browser, "manager");
  const owner = await signedIn(browser, "owner");
  // Stock in the register first: the owner witnesses a receipt the manager records.
  await manager.goto(`/people/${FRANK}/controlled-drugs`);
  const open = region(manager, "Open a register page");
  await open.getByLabel("Medicine on the MAR chart").selectOption({ label: OXYCODONE });
  await open.getByRole("button", { name: "Open the register page" }).click();
  await manager.waitForURL(/\/controlled-drugs\/[0-9a-f-]{36}/);
  const page = manager.url().split("?")[0] ?? "";
  await owner.goto(page);
  const sign = region(owner, "Sign as witness");
  await sign.getByLabel("What you saw").selectOption({ label: "Received" });
  await sign.getByLabel(/^How much, in/).fill("10");
  await sign.getByLabel("Who you watched record it").selectOption({ label: "Mo Manager" });
  await sign.getByRole("button", { name: "Sign as witness" }).click();
  await expect(status(owner, /Signed as witness\./)).toBeVisible();
  await manager.goto(page);
  const record = region(manager, "Record a movement");
  await record.getByLabel("What happened").selectOption({ label: "Received" });
  await record.getByLabel(/^How much, in/).fill("10");
  await record.getByLabel("From or to").fill("Example Pharmacy");
  await record.getByLabel("Reference").fill(`Delivery ${RUN}`);
  await record.getByRole("radio", { name: new RegExp(`^${OWNER}: Received, 10`) }).check();
  await record.getByRole("button", { name: "Record it" }).click();
  await expect(status(manager, "Recorded on the register.")).toBeVisible();

  // The dose: one phone said not given, the other given. The record that stands is corrected.
  await openConflicts(manager);
  await openConflict(manager, OXYCODONE, "The records differ");
  await expect(
    main(manager).getByText(/This is a controlled drug\. You will be asked/),
  ).toBeVisible();
  await bothThemes(manager, "controlled drug dose recorded twice");
  await main(manager).getByRole("link", { name: "Correct the record that stands" }).click();
  const form = main(manager).locator("form");
  await form.getByRole("radio", { name: "Given", exact: true }).check();
  await form.getByLabel(/^Amount given, in/).fill("1");
  await form.getByLabel("Why you are correcting it").fill(`It was given after waking, run ${RUN}`);
  // The page says exactly what the witness signs for, and gives the link they open.
  const witness = form.getByRole("group", { name: "Witness" });
  await expect(witness).toContainText("Your witness signs for a dose given of 1 capsule.");
  await bothThemes(manager, "controlled drug correction before the witness signs");
  await form.getByRole("button", { name: "Save correction" }).click();
  await expect(form.getByText(/Choose the witness's signature/).first()).toBeVisible();
  const link = await witness
    .getByRole("link", { name: "Open the witness page" })
    .getAttribute("href");
  await owner.goto(link ?? "");
  const dose = region(owner, "Sign as witness");
  await expect(dose).toContainText("You are signing for a correction of a dose record.");
  await expect(dose.getByLabel("What you saw")).toHaveValue("administration");
  await expect(dose.getByLabel(/^How much, in/)).toHaveValue("1");
  await bothThemes(owner, "witness signing for a dose record");
  await dose.getByRole("button", { name: "Sign as witness" }).click();
  await expect(status(owner, /Signed as witness\./)).toBeVisible();
  await witness.getByRole("button", { name: "Check for the signature" }).click();
  // Whether it was found is announced.
  await expect(
    form.getByText("Your witness's signature is here. Choose it under “The witness's signature”."),
  ).toBeAttached();
  await witness.getByLabel("The witness's signature").selectOption({ label: `Signed by ${OWNER}` });
  await form.getByRole("button", { name: "Save correction" }).click();
  await expect(status(manager, "Record corrected. Now decide what happened.")).toBeVisible();

  // Having corrected it, the manager may not decide it: the API says why, in its words.
  const decide = region(manager, "Decide what happened");
  await decide.getByRole("radio", { name: /has been corrected/ }).check();
  await decide.getByLabel("What you found out").fill(`Checked the register, run ${RUN}`);
  await decide.getByRole("button", { name: "Save decision" }).click();
  await expect(
    main(manager)
      .getByText(/decided by someone who did not record, give or upload/)
      .first(),
  ).toBeVisible();
  await bothThemes(manager, "controlled drug decision refused to the corrector");
  // The owner, who took no part in the dose, decides it.
  await owner.goto(manager.url().split("?")[0] ?? "");
  const theirs = region(owner, "Decide what happened");
  await theirs.getByRole("radio", { name: /has been corrected/ }).check();
  await theirs.getByLabel("What you found out").fill(`Witnessed the correction's dose, run ${RUN}`);
  await theirs.getByRole("button", { name: "Save decision" }).click();
  await expect(status(owner, "Decision saved")).toBeVisible();
  await expect(main(owner).getByRole("article")).toHaveCount(0);
  await bothThemes(owner, "no doses waiting for review");
  // The register has the dose, with the owner's signature.
  await manager.goto(page);
  await expect(region(manager, "Entries")).toContainText("Given");
});
