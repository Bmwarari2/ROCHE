import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import { expectAccessible, signIn, signInWithDemoPasskey } from "./support";

/**
 * The organisation's full export page (PLAT-015; hazard HZ-070) against the demo tenant. Only the
 * owner holds platform.export.create, and every export route needs a step-up with a second factor
 * (ADR-0072 amendment), so the owner signs in with the end-to-end passkey. The owner asks for an
 * export, the worker's job runs once (`exports:run`, as the worker would), the export is downloaded
 * once after the warning, and a second one is cancelled after confirming; the manager is offered
 * none of it. Every state is checked with axe.
 */

const API_DIR = fileURLToPath(new URL("../../api", import.meta.url));

test.describe.configure({ mode: "serial" });

const main = (page: Page) => page.getByRole("main");
/** The arrival: focus on the page's heading, and a status saying what was done. */
async function arrived(page: Page, words: string | RegExp) {
  await expect(page.getByRole("heading", { level: 1, name: "Data export" })).toBeFocused();
  await expect(main(page).getByRole("status").filter({ hasText: words })).toBeVisible();
}
const exportsList = (page: Page) =>
  page.getByRole("region", { name: "Exports" }).getByRole("listitem");

let manager: Awaited<ReturnType<BrowserContext["cookies"]>> = [];

test.beforeAll(async ({ browser }, testInfo) => {
  // Two sign-ins and a worker run: room beyond one test's default.
  test.setTimeout(180_000);
  const context = await browser.newContext({ baseURL: testInfo.project.use.baseURL });
  await signIn(await context.newPage(), "manager@example.invalid");
  manager = await context.cookies();
  await context.close();
});

/** The owner, signed in with their passkey: a fresh step-up. */
async function asOwner(page: Page) {
  await signInWithDemoPasskey(page, "owner");
  await page.goto("/settings/export");
  await expect(page.getByRole("heading", { level: 1, name: "Data export" })).toBeVisible();
}

/** Cancels an export an earlier attempt left being prepared, so a new one can be asked for. */
async function cancelInHand(page: Page) {
  if ((await main(page).getByText("An export is being prepared.").count()) === 0) return;
  const inHand = exportsList(page)
    .filter({ has: page.getByText(/^(Waiting to start|Being prepared)$/) })
    .first();
  await inHand.getByRole("button", { name: "Cancel export" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Cancel export" }).click();
  await arrived(page, "Export cancelled.");
}

test("the manager is offered no export", async ({ page, context }) => {
  await context.addCookies(manager);
  await page.goto("/");
  await expect(
    page.getByRole("navigation", { name: "Modules" }).getByRole("link", { name: "Data export" }),
  ).toHaveCount(0);
  await page.goto("/settings/export");
  await expect(main(page)).toContainText("You do not have access to this");
  await expectAccessible(page, "export refused");
});

test("hazard HZ-070 the owner asks for an export and downloads it once, after the warning", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await asOwner(page);
  await cancelInHand(page);
  await expectAccessible(page, "export page");

  await main(page).getByRole("button", { name: "Ask for an export" }).click();
  await arrived(page, "Export asked for. You will be told when it is ready.");
  const latest = exportsList(page).first();
  await expect(latest).toContainText("Waiting to start");
  await expectAccessible(page, "export asked for");

  execFileSync("pnpm", ["exports:run"], { cwd: API_DIR, stdio: "ignore" });
  await page.reload();
  await expect(latest).toContainText("Ready to download");
  await expect(latest).toContainText("The link expires");

  await latest.getByRole("button", { name: "Download" }).click();
  const sheet = page.getByRole("dialog", { name: "Download the export" });
  await expect(sheet).toContainText("You can download this file only once.");
  await expect(sheet).toContainText("everyone the organisation supports and employs");
  await expectAccessible(page, "download warning");
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    sheet.getByRole("link", { name: "Download now" }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/^harbour-export-[0-9a-f-]{36}\.zip$/);
  expect((await download.createReadStream()).readable).toBe(true);

  // The page then says it was downloaded, and offers it no more.
  await arrived(page, "Export downloaded.");
  await expect(latest).toContainText("Downloaded");
  await expect(latest.getByRole("button", { name: "Download" })).toHaveCount(0);
  await expectAccessible(page, "export downloaded");
});

test("the owner cancels an export after confirming, and a refused download says why", async ({
  page,
}) => {
  await asOwner(page);
  await cancelInHand(page);
  await main(page).getByRole("button", { name: "Ask for an export" }).click();
  await arrived(page, /^Export asked for\./);

  const latest = exportsList(page).first();
  await latest.getByRole("button", { name: "Cancel export" }).click();
  const sheet = page.getByRole("dialog", { name: "Cancel this export?" });
  await expect(sheet).toContainText("This cannot be undone");
  await expect(sheet.getByRole("button", { name: "Keep export" })).toBeVisible();
  await expectAccessible(page, "cancel confirmation");
  await sheet.getByRole("button", { name: "Cancel export" }).click();
  await arrived(page, "Export cancelled.");
  await expect(latest).toContainText("Cancelled");
  await expectAccessible(page, "export cancelled");

  await page.goto("/settings/export?problem=export_already_downloaded&at=1");
  const alert = page.getByRole("main").getByRole("alert");
  await expect(alert).toBeFocused();
  await expect(alert).toContainText("It has already been downloaded");
  await expectAccessible(page, "download refused");
});
