import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import {
  closeModules,
  expectAccessible,
  openModules,
  signIn,
  signInWithDemoPasskey,
} from "./support";

/**
 * The managers' team and invitation screens (PLAT-004; hazard HZ-011) against the demo tenant.
 * The manager (platform.user.manage at Harbour House) sees Team in the navigation, invites a new
 * member with an address unique to this attempt, sends the invitation again (the first is
 * withdrawn as superseded) and withdraws the new one, each after a confirmation; an address
 * already in the organisation is refused in words. The carer is offered none of it. An accepted
 * or lapsed invitation needs the emailed link or a day to pass, so those two states are covered
 * by the unit tests of their chips. Every state is checked with axe.
 */

const RUN = Date.now().toString(36);
const NAME = `Ada Example ${RUN}`;
const EMAIL = `invitee.${RUN}@example.invalid`;

test.describe.configure({ mode: "serial" });

const sessions: Record<string, Awaited<ReturnType<BrowserContext["cookies"]>>> = {};

test.beforeAll(async ({ browser }, testInfo) => {
  // Two sign-ins one after another: give the hook room beyond one test's default.
  test.setTimeout(180_000);
  for (const user of ["manager", "carer"]) {
    const context = await browser.newContext({ baseURL: testInfo.project.use.baseURL });
    const page = await context.newPage();
    // Inviting, sending again and withdrawing need a fresh step-up, which counts only from a
    // second factor (ADR-0072 amendment): the manager signs in with their passkey.
    if (user === "manager") await signInWithDemoPasskey(page);
    else await signIn(page, `${user}@example.invalid`);
    sessions[user] = await context.cookies();
    await context.close();
  }
});

async function as(page: Page, user: string) {
  await page.context().clearCookies();
  await page.context().addCookies(sessions[user] ?? []);
}

const main = (page: Page) => page.getByRole("main");
const alertIn = (page: Page) => main(page).getByRole("alert");

async function openTeam(page: Page) {
  await page.goto("/settings/team");
  await expect(page.getByRole("heading", { level: 1, name: "Team" })).toBeVisible();
}

async function confirmIn(page: Page, open: string, title: RegExp, confirm: string) {
  await main(page).getByRole("button", { name: open }).click();
  const sheet = page.getByRole("dialog", { name: title });
  await expect(sheet).toBeVisible();
  await expectAccessible(page, `${open} confirmation`);
  await sheet.getByRole("button", { name: confirm }).click();
  await expect(sheet).toBeHidden();
}

test("the carer is offered no team screens", async ({ page }) => {
  await as(page, "carer");
  await page.goto("/");
  await expect((await openModules(page)).getByRole("link", { name: "Team" })).toHaveCount(0);
  await closeModules(page);
  await page.goto("/settings/team");
  await expect(main(page)).toContainText("You do not have access to this");
  await expectAccessible(page, "team refused");
});

test("the manager invites someone, with errors in words", async ({ page }) => {
  await as(page, "manager");
  await page.goto("/");
  await (await openModules(page)).getByRole("link", { name: "Team" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Team" })).toBeVisible();
  // Members the manager reaches, each state an icon and a word.
  const carer = page
    .getByRole("listitem")
    .filter({ has: page.getByRole("link", { name: "Cat Carer" }) });
  await expect(carer).toContainText("Active");
  await expectAccessible(page, "team list");

  const form = main(page).getByRole("region", { name: "Invite someone" });
  await form.getByRole("button", { name: "Send invitation" }).click();
  await expect(alertIn(page)).toBeFocused();
  await expect(alertIn(page).getByRole("link", { name: "Enter their full name" })).toBeVisible();
  await expect(form.getByLabel("Full name")).toHaveAttribute("aria-invalid", "true");
  await expectAccessible(page, "invite form with errors");

  // An address already in the organisation is refused at the field.
  await form.getByLabel("Full name").fill(NAME);
  await form.getByLabel("Work email address").fill("carer@example.invalid");
  await form.getByLabel("Role", { exact: true }).selectOption({ label: "Care or support worker" });
  await form.getByLabel("Where the role applies").selectOption({ label: "Harbour House" });
  await form.getByRole("button", { name: "Send invitation" }).click();
  await expect(alertIn(page)).toContainText("already uses this email address");
  await expectAccessible(page, "invite refused");

  await form.getByLabel("Work email address").fill(EMAIL);
  await form.getByRole("button", { name: "Send invitation" }).click();
  await expect(page.getByRole("heading", { level: 1, name: NAME })).toBeVisible();
  await expect(main(page).getByRole("status").filter({ hasText: "Invitation sent" })).toBeFocused();
  const pending = page.getByRole("listitem").filter({ has: page.getByText("Pending") });
  await expect(pending).toHaveCount(1);
  await expect(main(page)).toContainText("Invited");
  await expectAccessible(page, "invited member");
});

test("the manager sends again and withdraws, after confirming", async ({ page }) => {
  await as(page, "manager");
  await openTeam(page);
  const row = page.getByRole("listitem").filter({ has: page.getByRole("link", { name: NAME }) });
  await expect(row).toContainText("Pending");
  await row.getByRole("link", { name: NAME }).click();
  await expect(page.getByRole("heading", { level: 1, name: NAME })).toBeVisible();

  await confirmIn(page, "Send a new invitation", /^Send an invitation to/, "Send invitation");
  await expect(main(page).getByRole("status").filter({ hasText: "Invitation sent" })).toBeFocused();
  // The first link was withdrawn when the new one was sent.
  await expect(page.getByRole("listitem").filter({ has: page.getByText("Withdrawn") })).toHaveCount(
    1,
  );
  await expect(page.getByRole("listitem").filter({ has: page.getByText("Pending") })).toHaveCount(
    1,
  );
  await expectAccessible(page, "sent again");

  await confirmIn(page, "Withdraw invitation", /^Withdraw this invitation/, "Withdraw invitation");
  await expect(
    main(page).getByRole("status").filter({ hasText: "Invitation withdrawn" }),
  ).toBeFocused();
  await expect(page.getByRole("listitem").filter({ has: page.getByText("Pending") })).toHaveCount(
    0,
  );
  await expect(main(page).getByRole("button", { name: "Withdraw invitation" })).toHaveCount(0);
  await expectAccessible(page, "withdrawn");
});

test("a member who has joined is never offered an invitation", async ({ page }) => {
  await as(page, "manager");
  await openTeam(page);
  await main(page).getByRole("link", { name: "Cat Carer" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Cat Carer" })).toBeVisible();
  await expect(main(page)).toContainText("Active");
  await expect(main(page).getByRole("button", { name: /invitation/i })).toHaveCount(0);
  await expectAccessible(page, "active member");
});
