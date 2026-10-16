import { expect, type Page, test } from "@playwright/test";
import { expectAccessible, signIn } from "./support";

/**
 * Letter and email templates on the web (COMMS-007; comms.md rules 18 to 23; hazard HZ-051): the
 * Registered Manager writes a draft, sees each problem the API found at its field, fixes it and is
 * told why they cannot approve their own draft; the owner approves it, starts a new draft and
 * discards it, and retires the version in use, each with a reason. Axe checks every state. Each
 * run makes its own template, named with the run.
 */

const RUN = `run ${Date.now().toString(36)}`;
const NAME = `Fee notice ${RUN}`;

const main = (page: Page) => page.getByRole("main");
const alertIn = (page: Page) => main(page).getByRole("alert");
const arrival = (page: Page) => page.locator("[data-arrival-notice]");

test.describe.configure({ mode: "serial" });

let templatePath = "";

test("hazard HZ-051 a draft shows each problem at its field, and its author cannot approve it", async ({
  page,
}) => {
  await signIn(page, "manager@example.invalid");
  await page.getByRole("navigation").getByRole("link", { name: "Letters" }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Letter and email templates" }),
  ).toBeVisible();
  await expectAccessible(page, "templates list");

  await page.getByRole("link", { name: "New template" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "New template" })).toBeVisible();
  await expectAccessible(page, "new template");

  // Nothing typed: each field says what to enter, from a summary that takes focus.
  await page.getByRole("radio", { name: "Email" }).check();
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(alertIn(page)).toBeFocused();
  await expect(alertIn(page)).toContainText("Enter a name of up to 200 characters");
  await expectAccessible(page, "new template refused");

  // Personal details in the subject and health details in an email: saved, with the problems.
  await page.getByLabel("Template name").fill(NAME);
  await page.getByLabel("Email subject").fill("About {{person.preferred_name}}");
  await page.getByLabel("Text").fill("{{incident.summary}}");
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(arrival(page)).toHaveText("Draft saved.");
  templatePath = new URL(page.url()).pathname;
  await expect(page.getByText("2 problems to fix before it can be approved.")).toBeVisible();
  const subject = page.getByLabel("Email subject");
  await expect(subject).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByLabel("Text")).toHaveAttribute("aria-invalid", "true");
  await expectAccessible(page, "draft with problems");

  await subject.fill("A letter from the home");
  await page
    .getByLabel("Text")
    .fill("Dear {{recipient.full_name}},\n\nThank you for your letter.\n\n{{sender.name}}");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(arrival(page)).toHaveText("Changes saved.");
  await expect(page.getByText("No problems found.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve this draft" })).toHaveCount(0);
  await expect(
    page.getByText("You wrote or edited this draft, so someone else who approves templates"),
  ).toBeVisible();
  await expectAccessible(page, "draft ready for someone else");
});

test("hazard HZ-051 someone else approves it; a new draft is discarded and the version retired, each with a reason", async ({
  page,
}) => {
  expect(templatePath).not.toBe("");
  await signIn(page, "owner@example.invalid");
  await page.goto("/letters");
  await page.getByRole("link", { name: NAME }).click();
  await page.getByRole("button", { name: "Approve this draft" }).click();
  await expect(arrival(page)).toHaveText("Draft approved: it is now the version in use.");
  await expect(page.getByRole("region", { name: "Version in use" })).toContainText(
    "Thank you for your letter.",
  );
  await expectAccessible(page, "approved");

  await page.getByRole("button", { name: "Start a new draft" }).click();
  await expect(arrival(page)).toHaveText("New draft started.");
  await page.getByRole("button", { name: "Discard this draft" }).click();
  await page.getByRole("button", { name: "Discard draft" }).click();
  await expect(alertIn(page)).toBeFocused();
  await expectAccessible(page, "discard refused");
  await page.getByLabel("Why is it being discarded?").fill("Started by mistake");
  await page.getByRole("button", { name: "Discard draft" }).click();
  await expect(arrival(page)).toHaveText("Draft discarded.");

  await page.getByRole("button", { name: "Retire this version" }).click();
  await page.getByLabel("Why is it being retired?").fill(`No longer used (${RUN})`);
  await page.getByRole("button", { name: "Retire version" }).click();
  await expect(arrival(page)).toHaveText("Version retired.");
  await expect(page.getByText("No version is in use")).toBeVisible();
  await expect(page.getByRole("region", { name: "Earlier versions" })).toContainText(
    "Started by mistake",
  );
  await expectAccessible(page, "retired");
});
