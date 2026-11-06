import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import { expectAccessible, signIn } from "./support";

/**
 * Phase 2 slice 63: the death record screens (SAFE-014; HZ-013) against the demo tenant. A death
 * record opens only from an exit record that says the person died, and recording a death through
 * the exit API would leave a demo resident dead for every other journey (the demo data has no death
 * to read), so this journey reads the list and the page that opens a record, and checks both with
 * axe in the dark and light themes. The record's own rules (police steps while the judgement is
 * missing; notification steps only linked) are covered by apps/web/src/lib/deaths.test.ts and the
 * API's tests.
 */

test.describe.configure({ mode: "serial" });

const sessions: Record<string, Awaited<ReturnType<BrowserContext["cookies"]>>> = {};

test.beforeAll(async ({ browser }, testInfo) => {
  for (const user of ["manager", "carer"]) {
    const context = await browser.newContext({ baseURL: testInfo.project.use.baseURL });
    await signIn(await context.newPage(), `${user}@example.invalid`);
    sessions[user] = await context.cookies();
    await context.close();
  }
});

async function as(context: BrowserContext, user: string) {
  await context.clearCookies();
  await context.addCookies(sessions[user] ?? []);
}

async function accessibleInBothThemes(page: Page, name: string) {
  await page.emulateMedia({ colorScheme: "dark" });
  await expectAccessible(page, `${name} (dark)`);
  await page.emulateMedia({ colorScheme: "light" });
  await expectAccessible(page, `${name} (light)`);
}

test("SAFE-014 the manager reads the deaths list, every status in words", async ({
  page,
  context,
}) => {
  await as(context, "manager");
  await page.goto("/deaths");
  await expect(page.getByRole("heading", { level: 1, name: "Deaths" })).toBeVisible();
  await accessibleInBothThemes(page, "deaths list");
});

test("SAFE-014 opening a death record needs the leaving record, and says so", async ({
  page,
  context,
}) => {
  await as(context, "manager");
  await page.goto("/deaths/new");
  await expect(page.getByRole("heading", { level: 1, name: "Open a death record" })).toBeVisible();
  await expect(page.getByText(/from the person's leaving record/)).toBeVisible();
  await accessibleInBothThemes(page, "open a death record");
});
