import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import { expectAccessible, signIn, signInWithDemoPasskey } from "./support";

/**
 * The import wizard (PLAT-014; platform.md rules 18 to 26; ADR-0092; hazard HZ-130) against the
 * demo tenant. Only the owner holds platform.import.run across the organisation, and commit and
 * undo need a step-up with a second factor, so the owner signs in with the end-to-end passkey.
 * The owner uploads the invented fixture (999-range NHS numbers; each run gives the rows fresh
 * numbers and a fresh local identifier so a run never meets an earlier run's people), matches the
 * columns, checks the file, is held back until each possible duplicate shown is ticked (and, with
 * phones in use, the no-undo acceptance), commits, sees the allergy status checks, and undoes it
 * where undo is available or reads that it is not. Every state is checked with axe in light and
 * dark. The manager, who works at one home, is offered none of it.
 */

const FIXTURE = fileURLToPath(new URL("./fixtures/import-people.csv", import.meta.url));

test.describe.configure({ mode: "serial" });

const main = (page: Page) => page.getByRole("main");

/** The arrival: focus on the page's heading, and a status saying what was done. */
async function arrived(page: Page, words: string) {
  await expect(page.getByRole("heading", { level: 1, name: "Import" })).toBeFocused();
  await expect(main(page).getByRole("status").filter({ hasText: words })).toBeVisible();
}

/** Uploads this run's fixture for the first home with the columns matched; lands on the batch. */
async function uploadFixture(page: Page) {
  await page.goto("/settings/import");
  const upload = page.getByRole("region", { name: "Upload a file" });
  await upload.getByLabel("Home").selectOption({ index: 1 });
  await upload.getByLabel("CSV file").setInputFiles({
    name: "people.csv",
    mimeType: "text/csv",
    buffer: fixtureForThisRun(),
  });
  await upload.getByLabel("Column 3: DOB").selectOption("date_of_birth");
  await upload.getByRole("button", { name: "Upload for checking" }).click();
  await arrived(page, "File uploaded.");
}

/** axe in both themes. */
async function accessibleInBothThemes(page: Page, name: string) {
  await page.emulateMedia({ colorScheme: "light" });
  await expectAccessible(page, `${name} (light)`);
  await page.emulateMedia({ colorScheme: "dark" });
  await expectAccessible(page, `${name} (dark)`);
  await page.emulateMedia({ colorScheme: "light" });
}

/** A valid NHS number in the 999 test range (modulus 11), different on each run. */
function freshNhsNumber(seed: number): string {
  for (let n = seed; ; n += 1) {
    const base = `999${String(n % 1_000_000).padStart(6, "0")}`;
    const sum = [...base].reduce((acc, digit, i) => acc + Number(digit) * (10 - i), 0);
    const check = 11 - (sum % 11);
    if (check === 10) continue;
    return `${base}${check === 11 ? 0 : check}`;
  }
}

/** The fixture with this run's NHS numbers and local identifier. */
function fixtureForThisRun(): Buffer {
  const seed = Date.now() % 900_000;
  const first = freshNhsNumber(seed);
  const second = freshNhsNumber(Number(first.slice(3, 9)) + 1);
  const text = readFileSync(FIXTURE, "utf8")
    .replace("9990010005", first)
    .replace("9990010072", second)
    .replace("IMPORT-FIXTURE-1", `IMPORT-FIXTURE-${seed}`);
  return Buffer.from(text, "utf8");
}

let manager: Awaited<ReturnType<BrowserContext["cookies"]>> = [];

test.beforeAll(async ({ browser }, testInfo) => {
  test.setTimeout(120_000);
  const context = await browser.newContext({ baseURL: testInfo.project.use.baseURL });
  await signIn(await context.newPage(), "manager@example.invalid");
  manager = await context.cookies();
  await context.close();
});

test("the manager is offered no import", async ({ page, context }) => {
  await context.addCookies(manager);
  await page.goto("/");
  await expect(
    page.getByRole("navigation", { name: "Modules" }).getByRole("link", { name: "Import people" }),
  ).toHaveCount(0);
  await page.goto("/settings/import");
  await expect(main(page)).toContainText("You do not have access to this");
  await accessibleInBothThemes(page, "import refused");
});

test("hazard HZ-130 the owner maps, checks, acknowledges, commits and undoes an import", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await signInWithDemoPasskey(page, "owner");
  await page.goto("/settings/import");
  await expect(page.getByRole("heading", { level: 1, name: "Import people" })).toBeVisible();
  await accessibleInBothThemes(page, "import page");

  // Step 1: the home and the file. Step 2: the columns.
  const upload = page.getByRole("region", { name: "Upload a file" });
  await upload.getByLabel("Home").selectOption({ index: 1 });
  await upload.getByLabel("CSV file").setInputFiles({
    name: "people.csv",
    mimeType: "text/csv",
    buffer: fixtureForThisRun(),
  });
  await expect(upload.getByText("Match the columns (7 columns, 3 rows)")).toBeVisible();
  // hazard HZ-130 the wizard shows the mapping beside the file's first rows before the dry run.
  await expect(upload.getByText("First rows: 14/03/1938, 02/09/1941, 02/09/1941")).toBeVisible();
  await expect(
    upload.getByText("First rows: no_known_allergies, has_allergies, (blank)"),
  ).toBeVisible();
  // Headings that name a field are matched; "DOB" and "Room" are not.
  await expect(upload.getByLabel("Column 1: Given name")).toHaveValue("given_name");
  await expect(upload.getByLabel("Column 3: DOB")).toHaveValue("");
  await accessibleInBothThemes(page, "import mapping");

  // A required field left unmatched is said before anything is uploaded.
  await upload.getByRole("button", { name: "Upload for checking" }).click();
  await expect(upload).toContainText("Match a column to each of these fields: Date of birth.");

  await upload.getByLabel("Column 3: DOB").selectOption("date_of_birth");
  await upload.getByRole("button", { name: "Upload for checking" }).click();
  await arrived(page, "File uploaded.");
  await expect(main(page)).toContainText("Waiting to be checked");
  await accessibleInBothThemes(page, "import staged");

  // Step 3: the dry run, with what committing does in words.
  await main(page).getByRole("button", { name: "Check the file" }).click();
  const report = page.getByRole("region", { name: "What the check found" });
  await expect(report).toContainText("3 rows checked: 3 ready, no errors");
  // The new report takes focus at its summary, so it is read at once.
  await expect(report.getByText(/^3 rows checked/)).toBeFocused();
  await expect(report.getByRole("heading", { name: "What adding the people does" })).toBeVisible();
  await expect(report).toContainText("Committing creates 3 people at the chosen home");
  await expect(report).toContainText("File says no known allergies: row 1");
  await expect(report).toContainText("File says they have allergies: row 2");
  // The possible duplicate names the other row.
  const duplicate = report.getByLabel(
    "Row 3 (Date of birth) may be the same person as row 2: same name and date of birth. I have checked it",
  );
  await expect(duplicate).toBeVisible();
  await accessibleInBothThemes(page, "import report");

  // Committing is held back until every possible duplicate shown is ticked.
  await report.getByRole("button", { name: "Add 3 people" }).click();
  const summary = report.getByRole("alert");
  await expect(summary).toBeFocused();
  await expect(summary).toContainText("Tick every possible duplicate once you have checked it.");
  // The summary links to the first box still to tick.
  await summary.getByRole("link", { name: /Tick every possible duplicate/ }).click();
  await expect(duplicate).toBeFocused();
  // An earlier run's people may be listed as well: every warning shown must be ticked.
  for (const box of await report.getByRole("checkbox", { name: /I have checked it$/ }).all()) {
    await box.check();
  }
  const noUndo = report.getByLabel("I accept that this import cannot be undone");
  const phonesInUse = (await noUndo.count()) > 0;
  if (phonesInUse) {
    await report.getByRole("button", { name: "Add 3 people" }).click();
    await expect(report.getByRole("alert")).toContainText(
      "Accept that this import cannot be undone.",
    );
    await noUndo.check();
  }

  // Step 4: commit, then the allergy status checks it raised.
  await report.getByRole("button", { name: "Add 3 people" }).click();
  await arrived(page, "People added.");
  await expect(main(page)).toContainText("3 people added.");
  await expect(main(page)).toContainText("2 allergy statuses to check");
  await expect(
    main(page).getByRole("link", { name: "Person 1: the file said no known allergies" }),
  ).toBeVisible();
  await expect(main(page).getByRole("link", { name: "Open your tasks" })).toBeVisible();
  await expect(main(page).getByText("People added", { exact: true }).first()).toBeVisible();
  await accessibleInBothThemes(page, "import committed");

  // Undo while available, else a plain statement that it is not.
  const undo = main(page).getByRole("button", { name: "Undo this import" });
  if (!phonesInUse && (await undo.count()) > 0) {
    await expect(main(page)).toContainText("This import can be undone until");
    await undo.click();
    await page.getByRole("dialog").getByRole("button", { name: "Remove 3 people" }).click();
    await arrived(page, "Import undone.");
    await expect(main(page)).toContainText("This import was undone at");
    await expect(main(page)).toContainText("Undone");
  } else {
    await expect(main(page)).toContainText("This import can no longer be undone.");
    await expect(undo).toHaveCount(0);
  }
  await accessibleInBothThemes(page, "import after undo");
});

test("the owner discards a staged file, and nothing is added", async ({ page }) => {
  test.setTimeout(120_000);
  await signInWithDemoPasskey(page, "owner");
  await uploadFixture(page);
  await main(page).getByRole("button", { name: "Discard this file" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Discard file" }).click();
  await arrived(page, "File discarded. Nothing was added.");
  await expect(main(page).getByText("Discarded", { exact: true })).toBeVisible();
  await expect(main(page).getByRole("button", { name: "Check the file" })).toHaveCount(0);
  await accessibleInBothThemes(page, "import discarded");
});
