import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import { expectAccessible, signIn } from "./support";

/**
 * The onboarding checklist (PLAT-018; platform-completions.md rules 26 and 27) against the demo
 * tenant. The Registered Manager reads it and is offered no decision; the owner records a setting
 * decision, keeps Harbour's retention period for a kind of record after a refused "not used",
 * chooses the staff file option and records the DCB0160 assessment, and each closes its item.
 * Every state is checked with axe. Decisions are append-only, so the journey can run again on the
 * same database: what an earlier run decided is no longer outstanding.
 */

test.describe.configure({ mode: "serial" });

const PAGE = "/settings/onboarding";
const main = (page: Page) => page.getByRole("main");
const item = (page: Page, title: string) =>
  main(page)
    .getByRole("listitem")
    .filter({ has: page.getByRole("heading", { level: 3, name: title }) });

async function recorded(page: Page) {
  await expect(page.getByRole("heading", { level: 1, name: "Getting started" })).toBeFocused();
  await expect(
    main(page).getByRole("status").filter({ hasText: "Decision recorded." }),
  ).toBeVisible();
}

let manager: Awaited<ReturnType<BrowserContext["cookies"]>> = [];

test.beforeAll(async ({ browser }, testInfo) => {
  test.setTimeout(120_000);
  const context = await browser.newContext({ baseURL: testInfo.project.use.baseURL });
  await signIn(await context.newPage(), "manager@example.invalid");
  manager = await context.cookies();
  await context.close();
});

test("the Registered Manager reads the checklist and is offered no decision", async ({
  page,
  context,
}) => {
  await context.addCookies(manager);
  await page.goto(PAGE);
  await expect(main(page).getByText(/of 15 done\./)).toBeVisible();
  await expect(item(page, "The DPIA is signed")).toBeVisible();
  await expect(main(page).getByRole("button", { name: /^Accept Harbour's setting: / })).toHaveCount(
    0,
  );
  // A go-live item Harbour cannot check yet says so, and blocks.
  await expect(
    item(page, "Shared and kiosk devices are enrolled in device management"),
  ).toContainText("Not done: blocks go-live");
  // Sample data is read from the records: the demo organisation has none in place, so it is done
  // (the sample data journey shows it blocking while a batch is loaded).
  await expect(item(page, "Sample data is removed")).toContainText("Done");
  await expect(item(page, "Sample data is removed")).not.toContainText("Not done");
  await expectAccessible(page, "onboarding checklist, read only");
});

test("the owner records the decisions, and each closes what it answers", async ({ page }) => {
  test.setTimeout(120_000);
  await signIn(page, "owner@example.invalid");
  await page.goto(PAGE);
  await expect(
    page
      .getByRole("navigation", { name: "Modules" })
      .getByRole("link", { name: "Getting started" }),
  ).toBeVisible();
  await expectAccessible(page, "onboarding checklist");

  const settings = item(page, "Other settings Harbour chose for you are reviewed");
  await expect(settings.getByText(/^Harbour's setting: /).first()).toBeVisible();
  const accept = settings.getByRole("button", { name: /^Accept Harbour's setting: / }).first();
  const key = ((await accept.getAttribute("aria-label")) ?? "").replace(
    "Accept Harbour's setting: ",
    "",
  );
  await accept.click();
  await recorded(page);
  await expect(
    item(page, "Other settings Harbour chose for you are reviewed").getByRole("button", {
      name: `Accept Harbour's setting: ${key}`,
    }),
  ).toHaveCount(0);

  // A kind of record with Harbour's period cannot be marked not used; keeping the period closes it.
  const retention = () => item(page, "How long records are kept is reviewed");
  const classes = await retention()
    .getByRole("button", { name: /^Keep Harbour's period for / })
    .evaluateAll((buttons) =>
      buttons.map((b) =>
        (b.getAttribute("aria-label") ?? "").replace("Keep Harbour's period for ", ""),
      ),
    );
  const recordClass = classes.find((c) => !["cctv", "organisation_document"].includes(c)) ?? "";
  await retention()
    .getByRole("button", { name: `We do not keep these: ${recordClass}` })
    .click();
  await expect(retention().getByRole("alert")).toContainText("Accept Harbour's period");
  await expectAccessible(page, "retention decision refused");
  await retention()
    .getByRole("button", { name: `Keep Harbour's period for ${recordClass}` })
    .click();
  await recorded(page);
  await expect(
    retention().getByRole("button", { name: `Keep Harbour's period for ${recordClass}` }),
  ).toHaveCount(0);

  const staffFile = retention().getByRole("group", { name: "How long do you keep staff files?" });
  if ((await staffFile.count()) > 0) {
    await staffFile.getByLabel("Until the person's 75th birthday").check();
    await retention().getByRole("button", { name: "Save the staff file choice" }).click();
    await recorded(page);
  }
  await expect(
    retention().getByRole("group", { name: "How long do you keep staff files?" }),
  ).toHaveCount(0);

  // HZ-027: a clinical setting is accepted only naming the clinical lead or CSO who reviewed it.
  const clinical = () => item(page, "Your clinical lead has reviewed the clinical settings");
  const first = clinical().getByRole("listitem").first();
  await first.getByRole("button", { name: /^Accept Harbour's setting: / }).click();
  await expect(
    first
      .getByText("Choose the clinical lead or Clinical Safety Officer who reviewed this setting")
      .first(),
  ).toBeVisible();
  await expectAccessible(page, "clinical setting without its reviewer");
  const clinicalKey = (
    (await first
      .getByRole("button", { name: /^Accept Harbour's setting: / })
      .getAttribute("aria-label")) ?? ""
  ).replace("Accept Harbour's setting: ", "");
  await first
    .getByLabel("Reviewed by the clinical lead or Clinical Safety Officer")
    .selectOption({ label: "Nell Nurse" });
  await first.getByRole("button", { name: /^Accept Harbour's setting: / }).click();
  await recorded(page);
  await expect(
    clinical().getByRole("button", { name: `Accept Harbour's setting: ${clinicalKey}` }),
  ).toHaveCount(0);

  const dcb = item(page, "Your DCB0160 clinical safety assessment is recorded");
  const record = dcb.getByRole("button", { name: /^Record the DCB0160 assessment for / });
  if ((await record.count()) > 0) {
    await dcb
      .getByLabel("Assessed by the Clinical Safety Officer or clinical lead")
      .selectOption({ label: "Nell Nurse" });
    await record.click();
    await recorded(page);
  }
  await expect(item(page, "Your DCB0160 clinical safety assessment is recorded")).toContainText(
    "Done",
  );
  await expectAccessible(page, "decisions recorded");
});
