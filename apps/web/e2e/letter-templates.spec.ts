import { type APIRequestContext, type Browser, expect, type Page, test } from "@playwright/test";
import { expectAccessible, signIn } from "./support";

/**
 * Letter and email templates on the web (COMMS-007; comms.md rules 18 to 23; hazard HZ-051): the
 * Registered Manager writes a draft, sees each problem the API found at its field, fixes it and is
 * told why they cannot approve their own draft; the owner approves it, starts a new draft and
 * discards it, and retires the version in use, each with a reason. Axe checks every state. Each
 * run makes its own template, named with the run.
 */

const RUN = `run ${Date.now().toString(36)}`;
const API_URL = process.env.API_URL ?? "http://localhost:4000";
const DEMO_TENANT = "0194d000-0000-7000-8000-000000000001";

interface Version {
  readonly id: string;
  readonly version: number;
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

async function signedIn(browser: Browser, email: string): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await signIn(page, email);
  return page;
}
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
  // Every counted problem is listed, each a link to its field (WCAG 3.3.1).
  const problems = page.getByRole("region", { name: "Problems to fix before it can be approved" });
  await expect(problems.getByRole("link")).toHaveCount(2);
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
  await expectAccessible(page, "new draft started");
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

test("hazard HZ-051 an approver edits only behind Edit draft, the form follows the stored words, and stale writes are refused", async ({
  page,
  browser,
}) => {
  const name = `Stale check ${RUN}`;
  const words = (n: number) => `Dear {{recipient.full_name}},\n\nVersion ${n} (${RUN}).`;
  await signIn(page, "manager@example.invalid");
  const owner = await signedIn(browser, "owner@example.invalid");
  const made = await call<{ id: string; draft: Version }>(
    page.request,
    "post",
    "/v1/letter-templates",
    {
      kind: "general",
      channel: "letter",
      name,
      subject: null,
      body: words(1),
    },
  );
  const base = `/v1/letter-templates/${made.id}/versions`;
  await call(owner.request, "post", `${base}/${made.draft.id}/approve`, {
    version: made.draft.version,
  });
  const draft = await call<Version>(owner.request, "post", base, {});
  const edit = (version: number, n: number) =>
    call<Version>(owner.request, "put", `${base}/${draft.id}`, {
      name,
      subject: null,
      body: words(n),
      version,
    });
  const second = await edit(draft.version, 2);

  // The manager can approve the owner's draft: the stored words are shown read-only beside Approve.
  await page.goto(`/letters/${made.id}`);
  const draftCard = page.getByRole("region", { name: "Draft", exact: true });
  await expect(draftCard).toContainText("Version 2");
  await expect(draftCard.getByRole("button", { name: "Approve this draft" })).toBeVisible();
  await draftCard.getByRole("button", { name: "Edit draft" }).click();
  await expect(draftCard.getByRole("button", { name: "Approve this draft" })).toHaveCount(0);
  await expect(draftCard.getByLabel("Text")).toHaveValue(/Version 2/);

  // The owner saves again; once the page is read again, the open form shows the new words.
  const third = await edit(second.version, 3);
  await page.getByRole("button", { name: "Retire this version" }).click();
  await page.getByLabel("Why is it being retired?").fill(`Replaced (${RUN})`);
  await page.getByRole("button", { name: "Retire version" }).click();
  await expect(arrival(page)).toHaveText("Version retired.");
  await expect(new URL(page.url()).searchParams.has("done")).toBe(false);
  await expect(draftCard.getByLabel("Text")).toHaveValue(/Version 3/);

  // A change saved by someone else meanwhile refuses this save, in words.
  await edit(third.version, 4);
  await draftCard.getByLabel("Text").fill(words(5));
  await draftCard.getByRole("button", { name: "Save changes" }).click();
  await expect(alertIn(page)).toContainText("Someone else changed this record.");
  await expectAccessible(page, "save refused as stale");

  // Approving what this page showed, now older than what is stored, is refused too.
  await draftCard.getByRole("button", { name: "Cancel" }).click();
  await draftCard.getByRole("button", { name: "Approve this draft" }).click();
  await expect(alertIn(page)).toContainText("Someone else changed this record.");
  await expectAccessible(page, "approve refused");
});
