import { expect, type Page, test } from "@playwright/test";
import { expectAccessible, signIn, signInWithDemoPasskey } from "./support";

/**
 * The statement of purpose with change tracking (QUAL-009; quality.md section 16; hazard HZ-080)
 * against the demo tenant. The manager loads the statement CQC holds when there is none (the owner
 * approves it), then drafts a revision that adds a location: the page says what changed and that
 * CQC may need an application too, and the manager, its author, is not offered approval. The
 * owner approves it, sees the CQC clock as an icon and a word with the due date, and, stepped up
 * with their passkey, records that it was sent. Every state passes axe in the light and dark
 * themes. Each run tags its words, so re-runs never depend on what earlier runs left.
 */

test.describe.configure({ mode: "serial" });

const TAG = `run ${Date.now()}`;
const PATH = "/quality/statement-of-purpose";
const main = (page: Page) => page.getByRole("main");

async function bothThemes(page: Page, name: string) {
  await page.emulateMedia({ colorScheme: "light" });
  await expectAccessible(page, name);
  await page.emulateMedia({ colorScheme: "dark" });
  await expectAccessible(page, `${name}, dark theme`);
  await page.emulateMedia({ colorScheme: "light" });
}

async function arrived(page: Page, words: string | RegExp) {
  await expect(page.getByRole("heading", { level: 1, name: "Statement of purpose" })).toBeFocused();
  await expect(main(page).getByRole("status").filter({ hasText: words })).toBeVisible();
}

/** Discards a draft an earlier run left, so this run starts from the version in force. */
async function discardLeftover(page: Page) {
  const discard = main(page).getByRole("form", { name: "Discard this draft" });
  if ((await discard.count()) === 0) return;
  await discard.getByLabel("Reason").fill(`Left by an earlier journey (${TAG})`);
  await discard.getByRole("button", { name: "Discard the draft" }).click();
  await arrived(page, "Draft discarded.");
}

/** Fills the whole statement for the baseline: every Schedule 3 item. */
async function fillBaseline(page: Page) {
  const editor = main(page).getByRole("form", { name: "Enter the statement CQC already holds" });
  await editor
    .getByLabel("Aims and objectives", { exact: true })
    .fill("To support older people to live well and safely, with choice and dignity.");
  await editor.getByLabel("Kinds of service").fill("Care home service with nursing");
  await editor
    .getByLabel("The range of needs the services meet")
    .fill("Older people, including people living with dementia and physical disabilities.");
  const contacts = editor.getByRole("group", { name: "3. Names and contact details" });
  await contacts.getByLabel("Full name").first().fill("Harbour Demo Care Ltd");
  await contacts.getByLabel("Business address").first().fill("1 Example Street, Exampleton");
  await contacts.getByLabel("Business telephone number").first().fill("01632 960000");
  await contacts.getByLabel("Address for notices").fill("1 Example Street, Exampleton");
  await editor.getByLabel("Legal status of the provider").selectOption("limited_company");
  await editor.getByRole("button", { name: "Add a location" }).click();
  const first = editor.getByRole("group", { name: "Location 1" });
  await first.getByLabel("Name").fill("Harbour House");
  await first.getByLabel("Business address").fill("1 Example Street, Exampleton");
  await editor.getByRole("button", { name: "Save the statement" }).click();
}

test("hazard HZ-080 the manager drafts a revision with its changes and prompts, and cannot approve it", async ({
  page,
  browser,
}, testInfo) => {
  test.setTimeout(240_000);
  await signIn(page, "manager@example.invalid");
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "Modules" })
    .getByRole("link", { name: "Statement of purpose" })
    .click();
  await expect(page.getByRole("heading", { level: 1, name: "Statement of purpose" })).toBeVisible();
  await discardLeftover(page);

  // No statement yet: load the one CQC holds, and have the owner approve it.
  if (
    (await main(page).getByRole("region", { name: "The statement CQC already holds" }).count()) > 0
  ) {
    await bothThemes(page, "baseline editor");
    await fillBaseline(page);
    await arrived(page, "Draft started.");
    const owner = await browser.newContext({ baseURL: testInfo.project.use.baseURL });
    const ownerPage = await owner.newPage();
    await signInWithDemoPasskey(ownerPage, "owner");
    await ownerPage.goto(PATH);
    await main(ownerPage).getByRole("button", { name: "Approve this version" }).click();
    await expect(main(ownerPage).getByRole("status")).toContainText("Version approved.");
    await owner.close();
    await page.reload();
  }

  await main(page).getByRole("button", { name: "Start a new draft" }).click();
  await arrived(page, "Draft started.");
  const editor = main(page).getByRole("form", { name: "Edit the draft" });
  await editor
    .getByLabel("Aims and objectives", { exact: true })
    .fill(`To support older people to live well, safely and with dignity (${TAG}).`);
  await editor.getByRole("button", { name: "Add a location" }).click();
  const added = editor.getByRole("group", { name: /^Location \d+$/ }).last();
  await added.getByLabel("Name").fill(`Harbour Lodge ${TAG}`);
  await added.getByLabel("Business address").fill("2 Example Street, Exampleton");
  await bothThemes(page, "revision editor");
  await editor.getByRole("button", { name: "Save the draft" }).click();
  await arrived(page, "Draft saved.");

  // What changed, section by section, and the prompt that CQC may need an application too.
  const changes = main(page).getByRole("region", { name: "What changed" });
  await expect(changes).toContainText("1. Aims and objectives");
  await expect(changes).toContainText(`Harbour Lodge ${TAG}`);
  await expect(changes).toContainText("You may also need to apply to CQC");
  // The author is never offered approval, and is told why.
  await expect(main(page).getByRole("button", { name: "Approve this version" })).toHaveCount(0);
  await expect(main(page)).toContainText("You wrote or edited this draft");
  await bothThemes(page, "revision saved");
});

test("hazard HZ-080 the owner approves the revision, sees the CQC clock and records it as sent", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await signInWithDemoPasskey(page, "owner");
  await page.goto(PATH);
  await expect(main(page).getByRole("region", { name: "What changed" })).toContainText(TAG);
  await bothThemes(page, "draft for approval");
  await main(page).getByRole("button", { name: "Approve this version" }).click();
  await arrived(page, /^Version approved\./);

  // The revision's clock: an icon and a word, with the due date in words.
  const card = main(page)
    .getByRole("region", { name: /^Version \d+: tell CQC$/ })
    .last();
  await expect(card.getByText("Due at CQC")).toBeVisible();
  await expect(card).toContainText(
    /Send it to CQC by \d{2}\/\d{2}\/\d{4} \d{2}:\d{2}, in \d+ days/,
  );
  await bothThemes(page, "revision due at CQC");

  const form = card.getByRole("form", { name: /^Record that version \d+ was sent to CQC$/ });
  // Nothing chosen: when, and how, are both asked for.
  await form.getByRole("button", { name: "Record it as sent" }).click();
  await expect(main(page).getByRole("alert")).toContainText("Enter the CQC reference");
  await form.getByRole("radio", { name: /^Just now|^Now/ }).check();
  await form.getByLabel("CQC reference, or how it was sent").fill(`Portal reference ${TAG}`);
  await form.getByRole("button", { name: "Record it as sent" }).click();
  await arrived(page, "Recorded as sent to CQC.");
  await expect(
    main(page).getByRole("region", { name: "Every version" }).getByText("Sent to CQC").first(),
  ).toBeVisible();
  await bothThemes(page, "revision sent to CQC");
});
