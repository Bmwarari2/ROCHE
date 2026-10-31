import { type APIRequestContext, type Browser, expect, type Page, test } from "@playwright/test";
import { demoPerson, expectAccessible, signIn } from "./support";

/**
 * Letters on a person's record (COMMS-007; comms.md rules 24 and 25; hazards HZ-051 and HZ-001):
 * the Registered Manager previews a fee letter, sees who it is about before sending, is asked for
 * the typed details and the confirmation, and makes it; when the template changes between the
 * preview and the send, the new preview is shown to check again; an email is refused in words.
 * Templates are made and approved through the API, each named with the run. Axe checks every state.
 */

const RUN = `run ${Date.now().toString(36)}`;
const API_URL = process.env.API_URL ?? "http://localhost:4000";
const DEMO_TENANT = "0194d000-0000-7000-8000-000000000001";
const ADA = demoPerson(1);
const PATH = `/people/${ADA}/letters`;

interface Version {
  readonly id: string;
  readonly version: number;
}
interface Template {
  readonly id: string;
  readonly draft: Version | null;
}

async function call<T>(
  request: APIRequestContext,
  method: "post" | "put",
  path: string,
  data: object,
) {
  const response = await request[method](`${API_URL}${path}`, {
    headers: { "x-harbour-tenant": DEMO_TENANT },
    data,
  });
  expect(response.ok(), `${path} ${await response.text()}`).toBe(true);
  return (await response.json()) as T;
}

/** A page signed in as someone else, for the second person a template's approval needs. */
async function other(browser: Browser, email: string): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await signIn(page, email);
  return page;
}

/** A template drafted by the manager and approved by the owner. */
async function approvedTemplate(
  manager: Page,
  owner: Page,
  channel: "letter" | "email",
  name: string,
) {
  const made = await call<Template>(manager.request, "post", "/v1/letter-templates", {
    kind: channel === "letter" ? "fee_review" : "general",
    channel,
    name,
    subject: channel === "email" ? "A letter from the home" : null,
    body:
      channel === "letter"
        ? "Dear {{recipient.full_name}},\n\nFrom {{fee.effective_date}} the weekly fee will be {{fee.new_weekly}}.\n\n{{sender.name}}"
        : "Dear {{recipient.full_name}},\n\nThank you.",
  });
  const draft = made.draft as Version;
  await call(
    owner.request,
    "post",
    `/v1/letter-templates/${made.id}/versions/${draft.id}/approve`,
    {
      version: draft.version,
    },
  );
  return made.id;
}

const main = (page: Page) => page.getByRole("main");
const alertIn = (page: Page) => main(page).getByRole("alert");
const arrival = (page: Page) => page.locator("[data-arrival-notice]");

async function fillFees(page: Page) {
  const date = page.getByRole("group", { name: "Date the new fee starts" });
  await date.getByLabel("Day", { exact: true }).fill("01");
  await date.getByLabel("Month", { exact: true }).fill("04");
  await date.getByLabel("Year", { exact: true }).fill("2027");
  await page.getByLabel("New weekly fee").fill("1,250.50");
}

test.describe.configure({ mode: "serial" });

test("hazard HZ-051 hazard HZ-001 a letter is checked in a preview that shows who it is about, then made", async ({
  page,
  browser,
}) => {
  const name = `Fee review ${RUN}`;
  await signIn(page, "manager@example.invalid");
  const owner = await other(browser, "owner@example.invalid");
  await approvedTemplate(page, owner, "letter", name);

  await page.goto(PATH);
  await expect(page.getByRole("heading", { name: "Make a letter" })).toBeVisible();
  await expectAccessible(page, "letters tab");

  await page.getByLabel("Template").selectOption({ label: name });
  await page.getByRole("button", { name: "Preview the letter" }).click();
  await expect(alertIn(page)).toBeFocused();
  await expect(alertIn(page)).toContainText("New weekly fee in pounds and pence");
  await expectAccessible(page, "typed details missing");

  await fillFees(page);
  await page.getByRole("button", { name: "Preview the letter" }).click();
  const preview = page.getByRole("region", { name: "Check before sending" });
  await expect(page.getByRole("heading", { name: "Check before sending" })).toBeFocused();
  await expect(preview).toContainText("About: Ada Example");
  await expect(preview).toContainText("the weekly fee will be £1,250.50");
  await expectAccessible(page, "preview");

  await page.getByRole("button", { name: "Make the letter" }).click();
  await expect(alertIn(page)).toContainText("Confirm you have checked the letter");
  await page.getByLabel("I have checked who this letter is about").check();
  await page.getByRole("button", { name: "Make the letter" }).click();
  await expect(arrival(page)).toHaveText(
    "Letter made. It is saved with the person's documents, ready to print.",
  );
  await expect(
    page
      .getByRole("region", { name: "Letters sent" })
      .getByRole("link", { name: "Open the letter" })
      .first(),
  ).toBeVisible();
  await expectAccessible(page, "letter made");
});

test("hazard HZ-051 a letter changed since the preview is shown again to check, and email is refused in words", async ({
  page,
  browser,
}) => {
  const name = `Changing fee ${RUN}`;
  await signIn(page, "manager@example.invalid");
  const owner = await other(browser, "owner@example.invalid");
  const templateId = await approvedTemplate(page, owner, "letter", name);

  await page.goto(PATH);
  await page.getByLabel("Template").selectOption({ label: name });
  await fillFees(page);
  await page.getByRole("button", { name: "Preview the letter" }).click();
  await expect(page.getByRole("heading", { name: "Check before sending" })).toBeFocused();

  // Meanwhile the owner writes a new version and the manager approves it.
  const draft = await call<Version>(
    owner.request,
    "post",
    `/v1/letter-templates/${templateId}/versions`,
    {},
  );
  const edited = await call<Version>(
    owner.request,
    "put",
    `/v1/letter-templates/${templateId}/versions/${draft.id}`,
    {
      name,
      subject: null,
      body: "Dear {{recipient.full_name}},\n\nFrom {{fee.effective_date}} the fee changes to {{fee.new_weekly}} a week.",
      version: draft.version,
    },
  );
  await call(
    page.request,
    "post",
    `/v1/letter-templates/${templateId}/versions/${draft.id}/approve`,
    {
      version: edited.version,
    },
  );

  await page.getByLabel("I have checked who this letter is about").check();
  await page.getByRole("button", { name: "Make the letter" }).click();
  await expect(alertIn(page).first()).toContainText("The letter has changed since you checked it.");
  const preview = page.getByRole("region", { name: "Check before sending" });
  await expect(preview).toContainText("the fee changes to £1,250.50 a week");
  await expect(page.getByLabel("I have checked who this letter is about")).not.toBeChecked();
  await expectAccessible(page, "letter changed");

  const email = `Email ${RUN}`;
  await approvedTemplate(page, owner, "email", email);
  await page.goto(PATH);
  // Sending email is not built: an email template is not offered, and the page says why.
  await expect(page.getByLabel("Template").locator("option", { hasText: email })).toHaveCount(0);
  await expect(
    page.getByText(
      "Email templates are not offered here yet, because Harbour cannot send email yet.",
    ),
  ).toBeVisible();
  await expectAccessible(page, "email templates left out");
});
