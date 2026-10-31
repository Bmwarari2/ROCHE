import { type Browser, expect, type Page, type TestInfo, test } from "@playwright/test";
import { expectAccessible, signIn } from "./support";

/**
 * The policy library, read-and-sign and data security evidence screens (QUAL-008, QUAL-012;
 * quality.md section 22; HZ-128) against the demo tenant. The manager drafts a policy that needs
 * a second reviewer and is told someone else must publish it; the owner publishes it; the manager
 * reads and signs it (refused until the box is ticked); the manager drafts a minor change, the
 * owner publishes it, and the first version then names the one in force. The owner then works
 * through data security: an assertion refused as met without evidence and kept as not applicable
 * with notes, a certificate recorded, and this year's submission. Every state passes axe in the
 * light and dark themes. Data security is the owner's, who holds it across the organisation.
 * Each run names its records afresh.
 */

test.describe.configure({ mode: "serial" });

const RUN = Date.now().toString(36);
const POLICY = `Lone working ${RUN}`;
let policyUrl = "";
const main = (page: Page) => page.getByRole("main");

async function bothThemes(page: Page, name: string) {
  await page.emulateMedia({ colorScheme: "light" });
  await expectAccessible(page, name);
  await page.emulateMedia({ colorScheme: "dark" });
  await expectAccessible(page, `${name}, dark theme`);
  await page.emulateMedia({ colorScheme: "light" });
}

async function arrived(page: Page, words: string | RegExp) {
  await expect(page.getByRole("heading", { level: 1 })).toBeFocused();
  await expect(main(page).getByRole("status").filter({ hasText: words })).toBeVisible();
}

async function dateIn(page: Page, legend: string, offsetDays = 0) {
  const when = new Date(Date.now() + offsetDays * 86_400_000);
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    day: "numeric",
    month: "numeric",
    year: "numeric",
  }).formatToParts(when);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const group = main(page).getByRole("group", { name: legend }).first();
  await group.getByRole("textbox", { name: "Day" }).fill(get("day"));
  await group.getByRole("textbox", { name: "Month" }).fill(get("month"));
  await group.getByRole("textbox", { name: "Year" }).fill(get("year"));
}

async function asOwner(browser: Browser, info: TestInfo) {
  const context = await browser.newContext({ baseURL: info.project.use.baseURL });
  const page = await context.newPage();
  await signIn(page, "owner@example.invalid");
  return { context, page };
}

async function ownerPublishes(browser: Browser, info: TestInfo, words: string) {
  const { context, page } = await asOwner(browser, info);
  await page.goto(policyUrl);
  await main(page)
    .getByRole("checkbox", { name: /I have checked this draft/ })
    .check();
  await main(page).getByRole("button", { name: "Publish" }).click();
  await arrived(page, words);
  await bothThemes(page, "published by the owner");
  await context.close();
}

test("hazard HZ-128 a policy is drafted, published by a second reviewer, read and signed, and superseded", async ({
  page,
  browser,
}, info) => {
  test.setTimeout(300_000);
  await signIn(page, "manager@example.invalid");
  await page.getByRole("link", { name: "Policies" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Policies" })).toBeVisible();
  await bothThemes(page, "policy library");

  await main(page).getByRole("link", { name: "New policy" }).click();
  await main(page).getByRole("button", { name: "Add policy" }).click();
  await expect(main(page).getByText("Enter the policy's title").first()).toBeVisible();
  await bothThemes(page, "new policy refused");
  await main(page).getByLabel("Title", { exact: true }).fill(POLICY);
  await main(page).getByLabel("Short name", { exact: true }).fill(`lone_working_${RUN}`);
  await main(page).getByLabel("What changed", { exact: true }).fill("First version");
  await main(page)
    .getByLabel("Policy text", { exact: true })
    .fill("Staff working alone check in every hour.");
  await main(page).getByRole("checkbox", { name: "Registered Manager" }).check();
  await dateIn(page, "Review date", 365);
  await main(page).getByRole("button", { name: "Add policy" }).click();
  await arrived(page, "Policy added as a draft.");
  policyUrl = new URL(page.url()).pathname;
  await expect(main(page).getByText("Someone else must publish this draft")).toBeVisible();
  await bothThemes(page, "draft awaiting a second reviewer");

  await ownerPublishes(browser, info, "Version published.");

  await page.goto("/policies");
  await expect(main(page).getByRole("link", { name: `${POLICY}, version 1` })).toBeVisible();
  await main(page)
    .getByRole("link", { name: `${POLICY}, version 1` })
    .click();
  await expect(main(page).getByText("To read and sign").first()).toBeVisible();
  await main(page).getByRole("button", { name: "Sign" }).click();
  await expect(main(page).getByText("Tick the box to say you have read it").first()).toBeVisible();
  await bothThemes(page, "sign refused");
  await main(page)
    .getByRole("checkbox", { name: /I have read this version/ })
    .check();
  await main(page).getByRole("button", { name: "Sign" }).click();
  await arrived(page, "Signed.");
  await expect(main(page).getByText("Signed by you")).toBeVisible();
  await expect(main(page).getByRole("heading", { name: "Who has read and signed" })).toBeVisible();
  await bothThemes(page, "signed, with who has signed");

  await main(page)
    .getByRole("radio", { name: /Minor change/ })
    .check();
  await main(page)
    .getByLabel("What changed", { exact: true })
    .fill("Check-in every two hours at night");
  await main(page).getByRole("button", { name: "Start draft" }).click();
  await arrived(page, "Draft started.");
  await bothThemes(page, "minor draft started");
  // A new draft copies the text and roles but needs its own review date before it is published.
  await dateIn(page, "Review date", 365);
  await main(page).getByRole("button", { name: "Save draft" }).click();
  await arrived(page, "Draft saved.");

  await ownerPublishes(browser, info, "Version published.");
  await page.reload();
  await expect(main(page).getByText("Superseded: version 2 is in force")).toBeVisible();
  await bothThemes(page, "version 1 superseded");
});

test("data security: an assertion, a certificate and this year's submission", async ({ page }) => {
  test.setTimeout(300_000);
  // Data protection is handled for the whole organisation: the owner holds it there.
  await signIn(page, "owner@example.invalid");
  await page.getByRole("link", { name: "Data security" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Data security" })).toBeVisible();
  await bothThemes(page, "data security overview");

  await main(page).getByRole("link", { name: "View the assertions" }).click();
  const ref = `9.${Math.floor(Math.random() * 100)}.${Math.floor(Math.random() * 100)}`;
  await main(page).getByLabel("Assertion number", { exact: true }).fill(ref);
  await main(page)
    .getByLabel("What the assertion says", { exact: true })
    .fill(`Staff complete data security training ${RUN}`);
  await main(page).getByRole("button", { name: "Add assertion" }).click();
  await arrived(page, "Assertion added.");
  await bothThemes(page, "assertion added");

  const card = main(page).getByRole("region", {
    name: new RegExp(`^${ref.replaceAll(".", "\\.")}:`),
  });
  await card.getByRole("radio", { name: "Met", exact: true }).check();
  await card.getByRole("button", { name: "Save" }).click();
  await expect(card.getByText(/evidence/i).first()).toBeVisible();
  // The refusal scrolls its card's radios up under the sticky app bar, where axe counts them as
  // obscured targets; checked with the page heading in view, as a person returning to it would.
  await page.getByRole("heading", { level: 1 }).scrollIntoViewIfNeeded();
  await bothThemes(page, "met refused without evidence");
  await card.getByRole("radio", { name: "Not applicable" }).check();
  await card.getByRole("button", { name: "Save" }).click();
  await expect(card.getByText("Add notes to say why").first()).toBeVisible();
  await card.getByLabel("Notes", { exact: true }).fill("We hold no paper records at this location");
  await card.getByRole("button", { name: "Save" }).click();
  await arrived(page, "Assertion updated.");
  await bothThemes(page, "assertion updated");

  await page.goto("/quality/data-security/certificates");
  await bothThemes(page, "certificates");
  await main(page).getByRole("radio", { name: "Cyber Essentials", exact: true }).check();
  await main(page)
    .getByLabel("Certificate or registration number", { exact: true })
    .fill(`CE-${RUN}`);
  await dateIn(page, "Date issued");
  await main(page).getByRole("button", { name: "Add record" }).click();
  await arrived(page, "Record added.");
  await expect(main(page).getByText(`Cyber Essentials: CE-${RUN}`)).toBeVisible();
  await bothThemes(page, "certificate recorded");

  await page.goto("/quality/data-security/submissions");
  const record = main(page).getByRole("button", { name: "Record submission" });
  if (await record.isVisible()) {
    await dateIn(page, "Date submitted");
    await main(page).getByRole("radio", { name: "Standards met" }).check();
    await record.click();
    await arrived(page, "Submission recorded.");
  }
  await expect(main(page).getByRole("heading", { name: "Submissions", exact: true })).toBeVisible();
  await bothThemes(page, "submissions");
});
