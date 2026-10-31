import { randomUUID } from "node:crypto";
import { type APIRequestContext, expect, type Page, test } from "@playwright/test";
import { expectAccessible, signIn, signInWithDemoPasskey } from "./support";

/**
 * Records retention (PLAT-012; retention.md) against the demo tenant. Only the owner (a tenant-wide
 * records role) holds platform.retention.manage, and every retention route needs a fresh step-up,
 * so the owner signs in with the end-to-end passkey; a password sign-in is sent to confirm first.
 * Rhys Example (seed-users.ts) left care nine years ago, past the care-record period, so a document
 * about him uploaded by this run is due for destruction. A legal hold on him takes it off the list;
 * released, it comes back; destroyed after the acknowledgement and the confirmation, it leaves a
 * certificate. The manager is offered none of it. Each state is checked with axe in light and dark.
 */

const API_URL = process.env.API_URL ?? "http://localhost:4000";
const DEMO_TENANT = "0194d000-0000-7000-8000-000000000001";
const RHYS = "0194d000-0000-7000-8600-000000000153";
const RUN = randomUUID().slice(0, 8);
const TITLE = `Old care letter ${RUN}`;
const PAGE = "/settings/retention";

test.describe.configure({ mode: "serial" });

const main = (page: Page) => page.getByRole("main");
const status = (page: Page, words: string | RegExp) =>
  main(page).getByRole("status").filter({ hasText: words });
const region = (page: Page, name: string) => main(page).getByRole("region", { name });

async function bothThemes(page: Page, name: string) {
  await expectAccessible(page, `${name} (light)`);
  await page.emulateMedia({ colorScheme: "dark" });
  await expectAccessible(page, `${name} (dark)`);
  await page.emulateMedia({ colorScheme: "light" });
}

const headers = { "x-harbour-tenant": DEMO_TENANT };

/** Releases holds on Rhys an earlier, interrupted run left, so his document is offered again. */
async function releaseLeftoverHolds(request: APIRequestContext) {
  const listed = await request.get(`${API_URL}/v1/legal-holds`, { headers });
  expect(listed.ok()).toBe(true);
  const { items } = (await listed.json()) as {
    items: { id: string; personId: string | null; releasedAt: string | null; version: number }[];
  };
  for (const hold of items.filter((h) => h.personId === RHYS && !h.releasedAt)) {
    await request.post(`${API_URL}/v1/legal-holds/${hold.id}/release`, {
      headers,
      data: { reason: "Left by an earlier journey run", version: hold.version },
    });
  }
}

/** A document about Rhys, uploaded as the owner: past retention the moment it is stored. */
async function uploadOldLetter(request: APIRequestContext) {
  const query = new URLSearchParams({ category: "person_document", title: TITLE, personId: RHYS });
  const response = await request.post(`${API_URL}/v1/documents?${query.toString()}`, {
    headers: { ...headers, "content-type": "application/pdf" },
    data: Buffer.from(`%PDF-1.7\n% ${RUN}\n1 0 obj\n<<>>\nendobj\n%%EOF\n`),
  });
  expect(response.status(), "upload").toBe(201);
}

test("the manager is offered no records retention", async ({ page }) => {
  await signIn(page, "manager@example.invalid");
  await expect(
    page
      .getByRole("navigation", { name: "Modules" })
      .getByRole("link", { name: "Records retention" }),
  ).toHaveCount(0);
  await page.goto(PAGE);
  await expect(main(page)).toContainText("You do not have access to this");
  await bothThemes(page, "retention refused");
});

test("a password sign-in is sent to confirm it is them first", async ({ page }) => {
  await signIn(page, "owner@example.invalid");
  await page.goto(PAGE);
  await page.waitForURL((url) => url.pathname === "/sign-in");
  const url = new URL(page.url());
  expect(url.searchParams.get("reason")).toBe("step-up");
  expect(url.searchParams.get("next")).toBe(PAGE);
});

test("a legal hold keeps a document from destruction; released, it is destroyed after confirming and certified", async ({
  page,
}) => {
  test.setTimeout(150_000);
  await signInWithDemoPasskey(page, "owner");
  await releaseLeftoverHolds(page.request);
  await uploadOldLetter(page.request);

  await page
    .getByRole("navigation", { name: "Modules" })
    .getByRole("link", { name: "Records retention" })
    .click();
  await expect(page.getByRole("heading", { level: 1, name: "Records retention" })).toBeVisible();
  const due = region(page, "Documents due for destruction");
  await expect(due.getByRole("checkbox", { name: new RegExp(TITLE) })).toBeVisible();
  await bothThemes(page, "retention page");

  // A hold on Rhys: his document is no longer offered.
  const place = region(page, "Place a legal hold");
  await place.getByRole("button", { name: "Place legal hold" }).click();
  await expect(place.getByText("Choose the person the hold covers.").first()).toBeVisible();
  // The summary takes focus at the foot of the form, which can leave the first radio under the
  // sticky app bar (axe then measures it against the bar): check the form as it is read, from
  // its heading.
  await place.getByRole("heading", { name: "Place a legal hold" }).scrollIntoViewIfNeeded();
  await page.evaluate(() => window.scrollBy(0, -80));
  await bothThemes(page, "hold errors");
  await place.getByLabel("Person", { exact: true }).selectOption({ label: "Rhys Example (left)" });
  await place.getByLabel("Why is the hold needed?").fill(`Claim received ${RUN}`);
  await place.getByRole("button", { name: "Place legal hold" }).click();
  await expect(status(page, "Legal hold placed.")).toBeVisible();
  const hold = region(page, "Legal holds in force")
    .getByRole("listitem")
    .filter({ hasText: `Claim received ${RUN}` });
  await expect(hold).toContainText("Every record about this person: Rhys Example");
  await expect(hold).toContainText("Hold in force");
  await expect(due.getByRole("checkbox", { name: new RegExp(TITLE) })).toHaveCount(0);
  await bothThemes(page, "hold in force");

  // Released with a reason: the document is offered again.
  await hold.getByRole("button", { name: "Release hold" }).click();
  const release = page.getByRole("dialog", { name: "Release this legal hold?" });
  await release.getByRole("button", { name: "Release hold" }).click();
  await expect(release.getByText(/Say why the hold can be released/).first()).toBeVisible();
  await bothThemes(page, "release dialog");
  await release.getByLabel("Why can the hold be released?").fill("Claim withdrawn by the family");
  await release.getByRole("button", { name: "Release hold" }).click();
  await expect(status(page, "Legal hold released.")).toBeVisible();
  await expect(
    region(page, "Released legal holds")
      .getByRole("listitem")
      .filter({ hasText: `Claim received ${RUN}` }),
  ).toContainText("Claim withdrawn by the family");

  // Destroying needs a choice, a reason and the acknowledgement, then a confirmation.
  await due.getByRole("button", { name: "Destroy chosen documents" }).click();
  await expect(due.getByText("Choose at least one document to destroy.").first()).toBeVisible();
  await expect(due.getByText(/Tick the box to say you understand/).first()).toBeVisible();
  await due.getByRole("checkbox", { name: new RegExp(TITLE) }).check();
  await due
    .getByLabel("Why are these records being destroyed?")
    .fill(`Annual records review ${RUN}`);
  await due.getByLabel(/I understand destroyed documents cannot be recovered/).check();
  await due.getByRole("button", { name: "Destroy chosen documents" }).click();
  const confirm = page.getByRole("dialog", { name: "Destroy 1 document permanently?" });
  await expect(confirm).toContainText("This cannot be undone.");
  await expect(confirm).toContainText("Every stored version of each file is deleted.");
  await bothThemes(page, "destruction confirmation");
  // Keeping the documents sends nothing.
  await confirm.getByRole("button", { name: "Keep the documents" }).click();
  await expect(confirm).toHaveCount(0);
  await expect(due.getByRole("checkbox", { name: new RegExp(TITLE) })).toBeVisible();

  await due.getByRole("button", { name: "Destroy chosen documents" }).click();
  await page
    .getByRole("dialog", { name: "Destroy 1 document permanently?" })
    .getByRole("button", { name: "Destroy 1 document" })
    .click();
  await expect(
    status(page, "1 document destroyed. 1 destruction certificate issued."),
  ).toBeVisible();
  await expect(due.getByRole("checkbox", { name: new RegExp(TITLE) })).toHaveCount(0);
  const certificate = region(page, "Destruction certificates")
    .getByRole("listitem")
    .filter({ hasText: `Annual records review ${RUN}` });
  await expect(certificate).toContainText("1 record (care records) destroyed");
  await expect(certificate).toContainText("Every stored version deleted");
  await bothThemes(page, "destroyed and certified");
});
