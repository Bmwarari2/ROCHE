import { randomUUID } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import { expectAccessible, signIn } from "./support";

/**
 * The organisation's documents (PLAT-009) against the demo tenant. The Registered Manager
 * (platform.document.manage) uploads a policy, signs it, and adds a new version: the new version
 * starts unsigned and the earlier one says it has been replaced and is no longer offered for
 * signing. A care worker reads the library but is offered no upload. Titles carry this run's tag,
 * so re-runs never depend on counts. Each state is checked with axe in light and dark themes.
 */

const RUN = randomUUID().slice(0, 8);
const TITLE = `Fire safety policy ${RUN}`;
const pdf = (words: string) => ({
  name: "fire-safety-policy.pdf",
  mimeType: "application/pdf",
  buffer: Buffer.from(`%PDF-1.7\n% ${words}\n1 0 obj\n<<>>\nendobj\n%%EOF\n`),
});

test.describe.configure({ mode: "serial" });

const main = (page: Page) => page.getByRole("main");
const status = (page: Page, words: string) =>
  main(page).getByRole("status").filter({ hasText: words });

async function bothThemes(page: Page, name: string) {
  await expectAccessible(page, `${name} (light)`);
  await page.emulateMedia({ colorScheme: "dark" });
  await expectAccessible(page, `${name} (dark)`);
  await page.emulateMedia({ colorScheme: "light" });
}

test("the manager uploads a policy, signs it and replaces it with a new version", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await signIn(page, "manager@example.invalid");
  await page
    .getByRole("navigation", { name: "Modules" })
    .getByRole("link", { name: "Documents" })
    .click();
  await expect(page.getByRole("heading", { level: 1, name: "Documents" })).toBeVisible();

  // Nothing chosen: each field says what to do.
  const upload = main(page).getByRole("region", { name: "Add a document" });
  await upload.getByRole("button", { name: "Upload document" }).click();
  await expect(upload.getByText("Choose a PDF file to upload.").first()).toBeVisible();
  await expect(upload.getByText(/Give the document a title/).first()).toBeVisible();
  await bothThemes(page, "upload errors");

  await upload.getByLabel("Title").fill(TITLE);
  await upload.getByLabel("File").setInputFiles(pdf(`first ${RUN}`));
  await upload.getByRole("button", { name: "Upload document" }).click();
  await expect(status(page, "Document uploaded.")).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: TITLE })).toBeFocused();
  const about = main(page).getByRole("region", { name: "About this document" });
  await expect(about).toContainText("Available");
  await expect(about).toContainText("Organisation document");
  await expect(about.getByRole("link", { name: "Download PDF" })).toHaveAttribute(
    "href",
    /^\/documents\/[0-9a-f-]{36}$/,
  );
  await expect(main(page).getByRole("region", { name: "Signatures" })).toContainText(
    "Nobody has signed this version.",
  );
  await bothThemes(page, "document details");
  const firstVersion = new URL(page.url()).pathname;

  // Signing needs a full name and the box ticked.
  const sign = main(page).getByRole("region", { name: "Sign this document" });
  await sign.getByRole("button", { name: "Sign document" }).click();
  await expect(sign.getByText(/Type your full name to sign/).first()).toBeVisible();
  await expect(
    sign.getByText("Tick the box to say you have read this version.").first(),
  ).toBeVisible();
  await bothThemes(page, "signing errors");
  await sign.getByLabel("Your full name").fill("Mo Example");
  await sign.getByLabel("I have read this version of the document").check();
  await sign.getByRole("button", { name: "Sign document" }).click();
  await expect(status(page, "Document signed.")).toBeVisible();
  await expect(main(page).getByRole("region", { name: "Signatures" })).toContainText(
    "Signed by Mo Example",
  );

  // A new version: the earlier one and its signature are kept; the new one starts unsigned.
  const version = main(page).getByRole("region", { name: "Upload a new version" });
  await version.getByLabel("New version").setInputFiles(pdf(`second ${RUN}`));
  await version.getByRole("button", { name: "Upload new version" }).click();
  await expect(status(page, "New version uploaded.")).toBeVisible();
  await expect(main(page).getByRole("region", { name: "Signatures" })).toContainText(
    "Nobody has signed this version.",
  );
  const versions = main(page).getByRole("region", { name: "Versions" });
  await expect(versions.getByRole("listitem")).toHaveCount(2);
  await expect(versions).toContainText("Version 2");
  await bothThemes(page, "new version");

  // The earlier version says it has been replaced and is not offered for signing.
  await page.goto(firstVersion);
  await expect(main(page).getByRole("note")).toContainText("A newer version has replaced it.");
  await expect(main(page).getByRole("region", { name: "Sign this document" })).toHaveCount(0);
  await expect(main(page).getByRole("region", { name: "Signatures" })).toContainText(
    "Signed by Mo Example",
  );
  await main(page).getByRole("link", { name: "Open version 2" }).click();
  await expect(page.getByRole("heading", { level: 1, name: TITLE })).toBeVisible();

  // The library lists the latest version only.
  await page.goto("/documents");
  const listed = main(page)
    .getByRole("listitem")
    .filter({ has: page.getByRole("link", { name: TITLE }) });
  await expect(listed).toHaveCount(1);
  await expect(listed).toContainText("Version 2");
  await bothThemes(page, "documents list");
});

test("a care worker reads the library but is offered no upload", async ({ page }) => {
  await signIn(page, "carer@example.invalid");
  await page.goto("/documents");
  await expect(page.getByRole("heading", { level: 1, name: "Documents" })).toBeVisible();
  await expect(main(page).getByRole("link", { name: TITLE })).toBeVisible();
  await expect(main(page).getByRole("region", { name: "Add a document" })).toHaveCount(0);
  await main(page).getByRole("link", { name: TITLE }).click();
  await expect(main(page).getByRole("region", { name: "Upload a new version" })).toHaveCount(0);
  await expect(main(page).getByRole("region", { name: "Sign this document" })).toBeVisible();
  await bothThemes(page, "care worker document");
});

test("the upload route refuses another site and a file over the limit, and takes a large PDF from the page", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await signIn(page, "manager@example.invalid");
  const route = "/api/documents/upload";
  const title = { "x-harbour-document-title": encodeURIComponent(`Refused ${RUN}`) };
  const crossSite = await page.request.post(route, {
    headers: {
      ...title,
      "content-type": "application/pdf",
      origin: "https://elsewhere.example.invalid",
    },
    data: pdf("cross-site").buffer,
  });
  expect(crossSite.status()).toBe(403);
  const origin = new URL(page.url()).origin;
  const oversize = await page.request.post(route, {
    headers: { ...title, "content-type": "application/pdf", origin },
    data: Buffer.alloc(25 * 1024 * 1024 + 1, 0x20),
  });
  expect(oversize.status()).toBe(413);
  expect(await oversize.json()).toMatchObject({ ok: false, code: "too_large" });

  // A 12 MB PDF goes through from the page (server actions keep Next's default body limit).
  await page.goto("/documents");
  const upload = main(page).getByRole("region", { name: "Add a document" });
  await upload.getByLabel("Title").fill(`Large policy ${RUN}`);
  await upload.getByLabel("File").setInputFiles({
    name: "large-policy.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.concat([
      Buffer.from("%PDF-1.7\n"),
      Buffer.alloc(12 * 1024 * 1024, 0x20),
      Buffer.from("\n%%EOF\n"),
    ]),
  });
  await upload.getByRole("button", { name: "Upload document" }).click();
  await expect(status(page, "Document uploaded.")).toBeVisible({ timeout: 60_000 });
});
