import { type Browser, expect, type Page, test } from "@playwright/test";
import { expectAccessible, signInWithDemoPasskey } from "./support";

/**
 * White-label branding (PLAT-002; platform.md, white-label branding) against the demo tenant. The
 * owner sets a display name and a colour that fails contrast: the screen says why in plain words
 * and offers the nearest colour that works, which they take and save; the shell shows the name and
 * the accent. They upload a logo, see it in the app bar, and remove it. Every state is checked with
 * axe in the light and dark themes. The display name carries a per-run tag, and the demo tenant's
 * branding is put back afterwards, so the journey can run again and other journeys see no change.
 */

test.describe.configure({ mode: "serial" });

const PAGE = "/settings/branding";
const TAG = Date.now().toString(36);
const NAME = `Lodge branding ${TAG}`;
// A 1 by 1 pixel PNG: an invented image, no one's data.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

const region = (page: Page, name: string) => page.getByRole("region", { name });

let original: { name: string; accent: string } | null = null;

async function asOwner(page: Page) {
  await signInWithDemoPasskey(page, "owner");
  await page.goto(PAGE);
  await expect(page.getByRole("heading", { level: 1, name: "Branding" })).toBeVisible();
}

async function bothThemes(page: Page, name: string) {
  await page.emulateMedia({ colorScheme: "light" });
  await expectAccessible(page, `${name} (light)`);
  await page.emulateMedia({ colorScheme: "dark" });
  await expectAccessible(page, `${name} (dark)`);
  await page.emulateMedia({ colorScheme: "light" });
}

async function arrived(page: Page, words: string) {
  await expect(page.getByRole("heading", { level: 1, name: "Branding" })).toBeFocused();
  await expect(page.getByRole("main").getByRole("status").filter({ hasText: words })).toBeVisible();
}

/** Puts the demo tenant's branding back as the journey found it, with no logo. */
async function restore(browser: Browser, baseURL: string | undefined) {
  if (!original) return;
  const context = await browser.newContext({ baseURL });
  const page = await context.newPage();
  await asOwner(page);
  const details = region(page, "Name and colour");
  await details.getByLabel("Display name").fill(original.name);
  await details.getByLabel("Accent colour").fill(original.accent);
  await details.getByRole("button", { name: "Save name and colour" }).click();
  await arrived(page, "Name and colour saved.");
  const remove = region(page, "Logo").getByRole("button", { name: "Remove logo" });
  if (await remove.isVisible()) {
    await remove.click();
    await arrived(page, "Logo removed.");
  }
  await context.close();
}

test.afterAll(async ({ browser }, testInfo) => {
  test.setTimeout(120_000);
  await restore(browser, testInfo.project.use.baseURL);
});

test("the owner sets a display name and takes the colour offered when theirs fails", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await asOwner(page);
  await expect(
    page.getByRole("navigation", { name: "Modules" }).getByRole("link", { name: "Branding" }),
  ).toBeVisible();
  const details = region(page, "Name and colour");
  original = {
    name: await details.getByLabel("Display name").inputValue(),
    accent: await details.getByLabel("Accent colour").inputValue(),
  };
  await bothThemes(page, "branding page");

  await details.getByLabel("Display name").fill(NAME);
  const accent = details.getByLabel("Accent colour");
  await accent.fill("#ffff00");
  await expect(
    details.getByText(
      "This colour cannot be used. This colour is too light: white words on it, such as on buttons, would be hard to read.",
    ),
  ).toBeVisible();
  await expect(details.getByText(/^Fails$/).first()).toBeVisible();
  await bothThemes(page, "a colour that fails, with the suggestion previewed");

  // Saving it anyway is refused at the field, before anything is sent.
  await details.getByRole("button", { name: "Save name and colour" }).click();
  await expect(details.getByText(/the nearest colour that works\./).first()).toBeVisible();

  const offer = details.getByRole("button", { name: /^Use #[0-9a-f]{6} instead$/ });
  const suggested = /Use (#[0-9a-f]{6}) instead/.exec((await offer.textContent()) ?? "")?.[1];
  expect(suggested).toBeTruthy();
  await offer.click();
  await expect(accent).toHaveValue(suggested ?? "");
  await expect(accent).toBeFocused();
  await expect(
    details.getByText("This colour can be read in the light and dark themes."),
  ).toBeVisible();
  await details.getByRole("button", { name: "Save name and colour" }).click();
  await arrived(page, "Name and colour saved.");

  // The shell shows the name and the accent, in both themes.
  await expect(page.getByRole("banner").getByText(NAME, { exact: true }).first()).toBeVisible();
  const shellAccent = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue("--accent").trim(),
  );
  expect(shellAccent).toBe(suggested);
  await bothThemes(page, "branding saved");
});

test("the owner uploads a logo, sees it in the app bar and removes it", async ({ page }) => {
  test.setTimeout(120_000);
  await asOwner(page);
  const logo = region(page, "Logo");
  await expect(logo.getByText("No logo yet.", { exact: false })).toBeVisible();

  // Not an image: refused before it is sent.
  await logo.getByLabel("Logo image").setInputFiles({
    name: "logo.svg",
    mimeType: "image/svg+xml",
    buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
  });
  await logo.getByRole("button", { name: "Upload logo" }).click();
  await expect(logo.getByText("The logo must be a PNG, JPEG or WebP image.").first()).toBeVisible();

  await logo
    .getByLabel("Logo image")
    .setInputFiles({ name: "logo.png", mimeType: "image/png", buffer: PNG });
  await logo.getByRole("button", { name: "Upload logo" }).click();
  await arrived(page, "Logo saved.");
  await expect(logo.getByRole("img", { name: "Your organisation's current logo" })).toBeVisible();
  const barLogo = page.getByRole("banner").locator("img.hb-appbar__logo");
  await expect(barLogo).toHaveAttribute("alt", "");
  await expect
    .poll(() => barLogo.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth))
    .toBe(1);
  await bothThemes(page, "branding with a logo");

  await logo.getByRole("button", { name: "Remove logo" }).click();
  await arrived(page, "Logo removed.");
  await expect(page.getByRole("banner").locator("img.hb-appbar__logo")).toHaveCount(0);
});
