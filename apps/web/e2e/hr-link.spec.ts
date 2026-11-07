import { expect, type Page, test } from "@playwright/test";
import { expectAccessible, signIn } from "./support";

/**
 * The link to the HR platform's settings page (integrations.md section 11; INTG-014; slice 90;
 * HZ-133) against the demo tenant. The link sits behind the organisation's
 * `integrations.thapsus_hr` flag, off by default, and the demo seed does not turn it on, nor does
 * any route let a journey turn it on: so these journeys cover the page as most organisations see
 * it. A care worker, who holds none of the link's permissions, is offered no menu entry and is
 * refused the page; the Registered Manager, who holds them all, is offered no menu entry while the
 * link is off and is told on the page that it is not turned on, with what to do meanwhile. The
 * linked states (connect, owners, locations, matches, deliveries, pay and releases) are covered by
 * the API tests against the contract-tested mock (apps/api/test/hr-link*.test.ts) and the page's
 * helpers (src/lib/hr-link.test.ts). Each state is checked with axe in light and dark.
 */

const PAGE = "/settings/hr-link";
const main = (page: Page) => page.getByRole("main");
/** The product's own name (`app.name`, ADR-0127). */
const PRODUCT_NAME = "Thapsus Care";
const modules = (page: Page) => page.getByRole("navigation", { name: "Modules" });

async function bothThemes(page: Page, name: string) {
  await expectAccessible(page, `${name} (light)`);
  await page.emulateMedia({ colorScheme: "dark" });
  await expectAccessible(page, `${name} (dark)`);
  await page.emulateMedia({ colorScheme: "light" });
}

test("a care worker is offered no link to the HR platform and is refused its page", async ({
  page,
}) => {
  await signIn(page, "carer@example.invalid");
  await expect(modules(page).getByRole("link", { name: "HR platform link" })).toHaveCount(0);
  await page.goto(PAGE);
  await expect(
    page.getByRole("heading", { level: 1, name: "Link to the HR platform" }),
  ).toBeVisible();
  await expect(main(page)).toContainText("You do not have access to this");
  await expect(main(page).getByRole("button")).toHaveCount(0);
  await bothThemes(page, "HR platform link refused");
});

test("the manager is told the link is not turned on, with nothing to change", async ({ page }) => {
  await signIn(page, "manager@example.invalid");
  // The menu offers the page only once the organisation has turned the link on.
  await expect(modules(page).getByRole("link", { name: "HR platform link" })).toHaveCount(0);
  await page.goto(PAGE);
  await expect(
    page.getByRole("heading", { level: 1, name: "Link to the HR platform" }),
  ).toBeVisible();
  await expect(
    main(page).getByRole("heading", {
      level: 2,
      name: "The link to the HR platform is not turned on",
    }),
  ).toBeVisible();
  await expect(main(page)).toContainText("keep staff files, leave and pay up to date in");
  // Nothing to connect, sync or release while the link is off.
  await expect(main(page).getByRole("button")).toHaveCount(0);
  await expect(main(page).getByRole("textbox")).toHaveCount(0);
  // HZ-133: never the other product (Thapsus-HR) in any spelling; this product's own name
  // (Thapsus Care, ADR-0127) is removed first, so any other "Thapsus" left fails.
  const read = await main(page).evaluate((el) => {
    const names = [...el.querySelectorAll("[aria-label],[title],[alt],[placeholder]")].flatMap(
      (e) => ["aria-label", "title", "alt", "placeholder"].map((a) => e.getAttribute(a) ?? ""),
    );
    return `${el.textContent ?? ""} ${names.join(" ")}`;
  });
  expect(read.replaceAll(PRODUCT_NAME, "")).not.toMatch(/thapsus/i);
  await bothThemes(page, "HR platform link not turned on");
});

test("the absence screen opens as before while the link is off, with no copies to label", async ({
  page,
}) => {
  await signIn(page, "manager@example.invalid");
  await page.goto("/absences");
  await expect(page.getByRole("heading", { level: 1, name: "Absences" })).toBeVisible();
  await expect(main(page).getByText("Managed in the HR platform")).toHaveCount(0);
  await bothThemes(page, "absences without the link");
});
