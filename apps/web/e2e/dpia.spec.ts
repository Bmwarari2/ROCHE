import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import { expectAccessible, signIn, signInWithDemoPasskey } from "./support";

/**
 * The DPIA in-app (PLAT-023; platform-completions.md rules 17 to 22) against the demo tenant. The
 * owner, signed in with the end-to-end passkey (a fresh step-up), names themselves the data
 * protection lead and sets the governance; the Registered Manager answers every question, rates
 * every risk and marks it ready to sign, and is offered neither the governance nor the signature;
 * the owner, who prepared none of it, signs it with their typed name. Every state is checked with
 * axe. Each run starts a new version, so the journey can run again on the same database.
 */

test.describe.configure({ mode: "serial" });

const PAGE = "/settings/data-protection";
const main = (page: Page) => page.getByRole("main");
const region = (page: Page, name: string) => page.getByRole("region", { name });

/** The arrival: focus on the page's heading, and a status saying what was done. */
async function arrived(page: Page, words: string) {
  await expect(page.getByRole("heading", { level: 1, name: "Data protection" })).toBeFocused();
  await expect(main(page).getByRole("status").filter({ hasText: words })).toBeVisible();
}

let manager: Awaited<ReturnType<BrowserContext["cookies"]>> = [];

test.beforeAll(async ({ browser }, testInfo) => {
  test.setTimeout(120_000);
  const context = await browser.newContext({ baseURL: testInfo.project.use.baseURL });
  await signIn(await context.newPage(), "manager@example.invalid");
  manager = await context.cookies();
  await context.close();
});

async function asOwner(page: Page) {
  await signInWithDemoPasskey(page, "owner");
  await page.goto(PAGE);
  await expect(page.getByRole("heading", { level: 1, name: "Data protection" })).toBeVisible();
}

test("the owner names the data protection lead and sets the governance", async ({ page }) => {
  test.setTimeout(120_000);
  await asOwner(page);
  await expect(
    page
      .getByRole("navigation", { name: "Modules" })
      .getByRole("link", { name: "Data protection" }),
  ).toBeVisible();
  await expectAccessible(page, "data protection page");
  const form = region(page, "Data protection responsibilities");
  await form.getByLabel("Data protection lead").selectOption({ label: "Olive Owner" });
  await form.getByLabel("Data protection officer's name").fill("Dee Example");
  await form.getByLabel("Data protection officer's email address").fill("dpo@example.invalid");
  await form.getByLabel("Link to your privacy notice").fill("http://example.invalid/privacy");
  await form
    .getByRole("group", { name: /data processing agreement/ })
    .getByLabel("Day")
    .fill("1");
  await form
    .getByRole("group", { name: /data processing agreement/ })
    .getByLabel("Month")
    .fill("9");
  await form
    .getByRole("group", { name: /data processing agreement/ })
    .getByLabel("Year")
    .fill("2026");
  await form
    .getByLabel(/anything other than direct care/)
    .selectOption({ label: "No, direct care only" });
  await form.getByRole("button", { name: "Save responsibilities" }).click();
  // A link that is not https is refused at the field, before anything is sent.
  await expect(form.getByText("Enter a link that starts with https://").first()).toBeVisible();
  await expectAccessible(page, "governance refused");
  await form
    .getByLabel("Link to your privacy notice")
    .fill("https://harbour.example.invalid/privacy");
  await form.getByRole("button", { name: "Save responsibilities" }).click();
  await arrived(page, "Responsibilities saved.");
  await expect(main(page).getByText("Harbour still needs these details")).toHaveCount(0);
});

test("the Registered Manager prepares it, and is offered neither the governance nor the signature", async ({
  page,
  context,
}) => {
  test.setTimeout(120_000);
  await context.addCookies(manager);
  await page.goto(PAGE);
  await expect(region(page, "Data protection responsibilities")).toHaveCount(0);
  await expect(region(page, "Sign the DPIA")).toHaveCount(0);
  await expectAccessible(page, "DPIA, the Registered Manager's view");
  const prepare = region(page, "Prepare the DPIA");
  // With no version open, saving starts one with Harbour's prefill.
  if ((await prepare.getByRole("textbox").count()) <= 1) {
    await prepare.getByRole("button", { name: "Save the DPIA" }).click();
    await arrived(page, "DPIA saved.");
  }
  for (const answer of await prepare.locator("textarea").all()) {
    await answer.fill("Considered with the team and recorded in our data protection policy.");
  }
  for (const rating of await prepare.getByRole("combobox").all()) {
    await rating.selectOption("low");
  }
  await expectAccessible(page, "DPIA being prepared");
  await prepare.getByRole("button", { name: "Save the DPIA" }).click();
  await arrived(page, "DPIA saved.");
  await region(page, "Prepare the DPIA")
    .getByRole("button", { name: "Mark ready to sign" })
    .click();
  await arrived(page, "DPIA marked ready to sign.");
  // The version signed before stays in force until this one is signed.
  await expect(region(page, "Prepare the DPIA")).toContainText("This version is ready to sign.");
  await expectAccessible(page, "DPIA ready to sign");
});

test("the named lead signs the prepared version with their typed name", async ({ page }) => {
  test.setTimeout(120_000);
  await asOwner(page);
  const sign = region(page, "Sign the DPIA");
  await expect(sign).toContainText("Version fingerprint");
  await sign.getByRole("button", { name: "Sign the DPIA" }).click();
  await expect(main(page).getByRole("alert")).toContainText("Type your full name to sign");
  await expectAccessible(page, "signature refused");
  await sign.getByLabel("Type your full name to sign").fill("Olive Owner");
  await sign.getByRole("button", { name: "Sign the DPIA" }).click();
  await arrived(page, "DPIA signed.");
  await expect(region(page, "Where the DPIA stands")).toContainText("Signed by Olive Owner");
  await expectAccessible(page, "DPIA signed");
});
