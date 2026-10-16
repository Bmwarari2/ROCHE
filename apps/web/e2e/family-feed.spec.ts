import { randomUUID } from "node:crypto";
import { type APIRequestContext, type Browser, expect, type Page, test } from "@playwright/test";
import { addDemoPasskey, demoPerson, expectAccessible, PASSWORD, signIn } from "./support";

/**
 * The family's updates in the portal (COMMS-001; comms.md rules 1 to 5; hazards HZ-022 and
 * HZ-061). The demo family member (Ada Example's next of kin, seed-users.ts) signs in with a
 * passkey, since the feed always needs MFA. With no sharing decision the feed says only that
 * these are not the full care record and when it was checked; under a decision an update shows;
 * an update they saw and that was taken down leaves a notice; and when the decision is withdrawn
 * the page reads exactly as it did with no decision. The manager acts through the API, with each
 * record named with the run. Axe checks every state.
 */

const RUN = Date.now().toString(36);
const API_URL = process.env.API_URL ?? "http://localhost:4000";
const DEMO_TENANT = "0194d000-0000-7000-8000-000000000001";
const ADA = demoPerson(1);
const FAMILY_MEMBER = "0194d000-0000-7000-8000-000000000305";
const STATEMENT =
  "These are everyday updates. They are not the full care record. The home will phone you about anything important.";

async function call<T>(request: APIRequestContext, path: string, data?: object): Promise<T> {
  const options = { headers: { "x-harbour-tenant": DEMO_TENANT }, ...(data ? { data } : {}) };
  const response = data
    ? await request.post(`${API_URL}${path}`, options)
    : await request.get(`${API_URL}${path}`, options);
  expect(response.ok(), `${path} ${await response.text()}`).toBe(true);
  // Taking an update down answers 204 with no body.
  const text = await response.text();
  return (text ? JSON.parse(text) : {}) as T;
}

interface Decision {
  readonly id: string;
  readonly recipient: { readonly kind: string; readonly contactId?: string };
  readonly inForce: boolean;
  readonly withdrawnAt: string | null;
  readonly version: number;
}

/** The family member's contact on Ada's record, from their portal link. */
interface Link {
  readonly id: string;
  readonly contactId: string;
  readonly tenantUserId: string;
  readonly revokedAt: string | null;
  readonly version: number;
}

/** The family member's open link on Ada's record, made again if an earlier run revoked it. */
async function familyLink(manager: Page): Promise<Link> {
  const read = async () =>
    (await call<{ items: Link[] }>(manager.request, `/v1/people/${ADA}/family-portal-links`)).items
      .filter((l) => l.tenantUserId === FAMILY_MEMBER)
      .sort((a, b) => Number(a.revokedAt !== null) - Number(b.revokedAt !== null));
  const [first] = await read();
  expect(
    first,
    "the demo family member is linked (seed-users.ts with HARBOUR_DEMO_E2E_PASSKEY=1)",
  ).toBeTruthy();
  if (first && first.revokedAt === null) return first;
  await call(manager.request, `/v1/people/${ADA}/family-portal-links`, {
    tenantUserId: FAMILY_MEMBER,
    contactId: first?.contactId,
  });
  return (await read())[0] as Link;
}

const familyContact = async (manager: Page) => (await familyLink(manager)).contactId;

/** Withdraws every decision for the contact still open, so the feed is closed. */
async function closeDecisions(manager: Page, contactId: string) {
  const decisions = await call<{ items: Decision[] }>(
    manager.request,
    `/v1/people/${ADA}/sharing-decisions`,
  );
  for (const decision of decisions.items) {
    if (decision.recipient.contactId !== contactId || decision.withdrawnAt) continue;
    await call(manager.request, `/v1/people/${ADA}/sharing-decisions/${decision.id}/withdraw`, {
      reason: `End-to-end run ${RUN}`,
      version: decision.version,
    });
  }
}

async function managerPage(browser: Browser): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await signIn(page, "manager@example.invalid");
  return page;
}

async function signInFamily(page: Page) {
  await addDemoPasskey(page, "family");
  await page.goto("/sign-in");
  await page.getByRole("button", { name: "Sign in with a passkey" }).click();
  // A family member's home is their updates.
  await page.waitForURL((url) => url.pathname === "/updates");
}

const feed = (page: Page) => page.getByRole("region", { name: "Updates from the home" });
/** The feed's words without the time it was checked, which moves on between reads. */
const feedWords = async (page: Page) =>
  (await feed(page).innerText()).replace(/Checked at [^.]+\./, "Checked at <time>.");

test.describe.configure({ mode: "serial" });

test("hazard HZ-022 hazard HZ-061 the family sees only what a decision opens, a taken-down notice, and a closed feed like no decision", async ({
  page,
  browser,
}) => {
  const manager = await managerPage(browser);
  const contactId = await familyContact(manager);
  await closeDecisions(manager, contactId);

  await signInFamily(page);
  await expect(page.getByRole("heading", { level: 1, name: "Updates" })).toBeVisible();
  // A portal session sees none of the staff navigation: no people list, no location switcher.
  await expect(page.getByRole("link", { name: "Updates", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Residents", exact: true })).toHaveCount(0);
  await expect(page.getByText("Location:", { exact: true })).toHaveCount(0);
  await expect(feed(page)).toContainText(STATEMENT);
  await expect(feed(page)).toContainText(/Checked at \d{2}\/\d{2}\/\d{4} \d{2}:\d{2}\./);
  await expect(feed(page)).toContainText("There are no updates to show.");
  await expect(feed(page)).not.toContainText("Last update");
  const noDecision = await feedWords(page);
  await expectAccessible(page, "no decision");

  // A decision opens activities; the manager records and publishes one.
  await call(manager.request, `/v1/people/${ADA}/sharing-decisions`, {
    recipient: { kind: "family", contactId },
    sections: ["activities_and_visits"],
    basis: "consent",
    consentGivenBy: "person",
    validTo: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
  });
  const activity = await call<{ id: string }>(manager.request, `/v1/people/${ADA}/activities`, {
    // After the decision began: an update from before it stays closed (HZ-022).
    occurredAt: new Date().toISOString(),
    activity: `Choir ${RUN}`,
    format: "one_to_one",
    attendance: "attended",
    engagement: "engaged_throughout",
  });
  const published = await call<{ item: { id: string } }>(
    manager.request,
    `/v1/people/${ADA}/feed`,
    {
      id: randomUUID(),
      source: { kind: "activity", activityId: activity.id },
    },
  );

  await page.reload();
  const entry = feed(page)
    .getByRole("listitem")
    .filter({ hasText: `Choir ${RUN}` });
  await expect(entry).toHaveCount(1);
  await expect(feed(page)).toContainText("Last update");
  await expectAccessible(page, "an update");

  // Taken down after the family saw it: a notice in its place, never what it said or why.
  await call(manager.request, `/v1/feed-items/${published.item.id}/withdraw`, {
    reason: "published_in_error",
  });
  await page.reload();
  await expect(
    feed(page)
      .getByRole("listitem")
      .filter({ hasText: `Choir ${RUN}` }),
  ).toHaveCount(0);
  await expect(feed(page).getByText("Taken down", { exact: true }).first()).toBeVisible();
  await expect(feed(page)).toContainText("This update was taken down because it was not right.");
  await expectAccessible(page, "taken down");

  // The decision withdrawn: the feed reads exactly as it did with no decision.
  await closeDecisions(manager, contactId);
  await page.reload();
  await expect(feed(page)).toContainText("There are no updates to show.");
  expect(await feedWords(page)).toBe(noDecision);
  await expectAccessible(page, "decision withdrawn");
  await manager.context().close();
});

test("a family member who has not confirmed it is them, or whose link was revoked, is told so", async ({
  page,
  browser,
}) => {
  const manager = await managerPage(browser);
  const link = await familyLink(manager);
  // A password alone: the feed needs a passkey or a phone code first.
  await page.goto("/sign-in");
  await page.getByLabel("Email address").fill("relative.example@example.invalid");
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL((url) => url.pathname === "/updates");
  await expect(page.getByRole("link", { name: "Set up a passkey or a phone code" })).toBeVisible();
  await expect(feed(page)).toHaveCount(0);
  await expectAccessible(page, "MFA notice");

  // The link revoked: the account has no access at all, and the page says how to get it. The
  // next run (or the next family test) makes the link again.
  await call(manager.request, `/v1/people/${ADA}/family-portal-links/${link.id}/revoke`, {
    reason: `End-to-end run ${RUN}`,
    version: link.version,
  });
  const family = await (await browser.newContext()).newPage();
  await signInFamily(family);
  await expect(family.getByText("Your account has no access yet.", { exact: false })).toBeVisible();
  await expect(family.getByRole("link", { name: "Residents", exact: true })).toHaveCount(0);
  await expectAccessible(family, "not linked");
  await family.context().close();
  await familyLink(manager);
  await manager.context().close();
});

test("a staff member without the family's permission is not shown the updates page", async ({
  page,
}) => {
  await signIn(page, "carer@example.invalid");
  await expect(page.getByRole("link", { name: "Updates", exact: true })).toHaveCount(0);
  await page.goto("/updates");
  await expect(page.getByRole("heading", { level: 1, name: "Updates" })).toBeVisible();
  await expect(feed(page)).toHaveCount(0);
});
