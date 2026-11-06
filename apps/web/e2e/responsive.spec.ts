import { expect, type Page, test } from "@playwright/test";
import { demoPerson, expectAccessible, signIn } from "./support";

/**
 * Responsive web down to 360 px (MOB-013, master prompt 17.4; WCAG 1.4.10 reflow). Run by the
 * `mobile-360` project at 360 × 740 and the `mobile-320` project at WCAG's 320 px: every screen
 * sampled here fits the width with no horizontal page scroll (wide tables scroll inside their own
 * container), keeps 44 px targets on what can be pressed, menus included, and passes axe; type
 * follows the browser's text size. Demo accounts and invented people only.
 */

const HARBOUR_HOUSE = "0194d000-0000-7000-8000-000000000101";

/** The page scrolls sideways when its content is wider than the viewport. */
async function expectNoHorizontalOverflow(page: Page, name: string) {
  const report = await page.evaluate(() => {
    const viewport = document.documentElement.clientWidth;
    const scrollWidth = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth);
    // What reaches past the right edge, outside any container that scrolls or clips it.
    const clipped = (el: Element): boolean => {
      for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
        const overflowX = getComputedStyle(p).overflowX;
        if (overflowX === "auto" || overflowX === "scroll" || overflowX === "hidden") return true;
      }
      return false;
    };
    const offenders: string[] = [];
    for (const el of Array.from(document.body.querySelectorAll("*"))) {
      const box = el.getBoundingClientRect();
      if (box.width === 0 || box.right <= viewport + 1 || clipped(el)) continue;
      const style = getComputedStyle(el);
      if (style.position === "fixed" || style.visibility === "hidden") continue;
      const id = el.id ? `#${el.id}` : "";
      const cls =
        typeof el.className === "string" && el.className
          ? `.${el.className.trim().split(/\s+/).slice(0, 2).join(".")}`
          : "";
      offenders.push(`${el.tagName.toLowerCase()}${id}${cls} (right ${Math.round(box.right)})`);
      if (offenders.length >= 8) break;
    }
    return { viewport, scrollWidth, offenders };
  });
  expect(
    report.scrollWidth,
    `${name}: page is ${report.scrollWidth}px wide in a ${report.viewport}px viewport; widest: ${report.offenders.join(", ")}`,
  ).toBeLessThanOrEqual(report.viewport);
}

/**
 * Everything that can be pressed or typed into is at least 44 px in both directions (section 8),
 * menus and sheets included. A radio or checkbox is measured by its card or label, which is the
 * target. A link exempt as inline (WCAG 2.5.8) is one inside a sentence: its nearest block has
 * other words besides it.
 */
async function expectTouchTargets(page: Page, name: string) {
  const small = await page.evaluate(() => {
    const out: string[] = [];
    const selector = [
      "a[href]",
      "button",
      "input:not([type=hidden])",
      "select",
      "textarea",
      "summary",
      "[tabindex='0']",
      ...["button", "tab", "switch", "checkbox", "radio", "menuitem", "option", "link"].map(
        (role) => `[role=${role}]`,
      ),
    ].join(", ");
    const blockOf = (el: Element): Element => {
      let p = el.parentElement;
      while (p && getComputedStyle(p).display.startsWith("inline")) p = p.parentElement;
      return p ?? document.body;
    };
    const inSentence = (el: HTMLElement): boolean => {
      if (el.tagName !== "A") return false;
      const block = blockOf(el);
      const own = (el.textContent ?? "").trim();
      const all = (block.textContent ?? "").trim();
      return all.length > own.length + 1;
    };
    for (const el of Array.from(document.querySelectorAll<HTMLElement>(selector))) {
      if (el.closest("[aria-hidden=true], [inert]")) continue;
      // The skip link waits off screen until it has focus.
      if (el.classList.contains("hb-skip-link")) continue;
      let target: Element = el;
      if (el instanceof HTMLInputElement && (el.type === "radio" || el.type === "checkbox")) {
        target = el.closest("label") ?? el;
      }
      const box = target.getBoundingClientRect();
      if (box.width <= 1 || box.height <= 1) continue;
      if (getComputedStyle(el).visibility === "hidden") continue;
      if (inSentence(el)) continue;
      if (box.height < 43.5 || box.width < 43.5) {
        const label = (el.getAttribute("aria-label") ?? el.textContent ?? "").trim().slice(0, 40);
        out.push(
          `${el.tagName.toLowerCase()} "${label}" ${Math.round(box.width)}×${Math.round(box.height)}`,
        );
      }
      if (out.length >= 8) break;
    }
    return out;
  });
  expect(small, `${name}: controls smaller than 44 px`).toEqual([]);
}

async function checkScreen(page: Page, path: string, name: string) {
  await page.goto(path);
  await expect(page.locator("main")).toBeVisible();
  await page.waitForLoadState("networkidle");
  await expectNoHorizontalOverflow(page, name);
  await expectTouchTargets(page, name);
  await expectAccessible(page, name);
}

/** A sample of every module's screens, as the manager sees them. */
const MANAGER_SCREENS: readonly [string, string][] = [
  ["/", "dashboard"],
  ["/people", "people"],
  [`/people/${demoPerson(1)}`, "person overview"],
  [`/people/${demoPerson(1)}/details`, "personal details"],
  [`/people/${demoPerson(1)}/care-plan`, "care plan"],
  [`/people/${demoPerson(1)}/notes`, "notes"],
  [`/people/${demoPerson(1)}/charts`, "charts"],
  [`/people/${demoPerson(1)}/risk-assessments`, "risk assessments"],
  [`/people/${demoPerson(1)}/history`, "history"],
  ["/people/pre-admission", "pre-admission"],
  ["/people/reviews", "reviews"],
  ["/round", "round"],
  [`/round/${HARBOUR_HOUSE}`, "round at a location"],
  ["/handover", "handover"],
  [`/handover/${HARBOUR_HOUSE}`, "handover at a location"],
  ["/tasks", "tasks"],
  ["/approvals", "approvals"],
  ["/incidents", "incidents"],
  ["/incidents/new", "new incident"],
  ["/incidents/trends", "incident trends"],
  ["/documents", "documents"],
  ["/letters", "letters"],
  ["/notifications", "notifications"],
  ["/notifications/statutory", "statutory notifications"],
  ["/quality/evidence-packs", "evidence packs"],
  ["/quality/statement-of-purpose", "statement of purpose"],
  ["/downtime", "downtime"],
  ["/search?q=Example", "search"],
  ["/updates", "updates"],
];

const OWNER_SCREENS: readonly [string, string][] = [
  ["/settings/team", "team"],
  ["/settings/security", "security"],
  ["/settings/data-protection", "data protection"],
  ["/settings/retention", "retention"],
  ["/settings/export", "export"],
  ["/settings/branding", "branding"],
  ["/settings/onboarding", "onboarding"],
  ["/break-glass/weekly-report", "break-glass weekly report"],
];

test.describe("360 px wide", () => {
  test("sign-in fits, with 44 px targets and no serious accessibility problems", async ({
    page,
  }) => {
    await checkScreen(page, "/sign-in", "sign-in");
  });

  test("the app bar and navigation work at 360 px", async ({ page }) => {
    await signIn(page, "manager@example.invalid");
    await expectNoHorizontalOverflow(page, "dashboard");
    // The sidebar gives way to the app bar's "Menu", so the page keeps its whole width.
    await expect(page.getByRole("navigation", { name: "Modules" })).toBeHidden();
    const account = page.getByRole("button", { name: /^Your account/ });
    await expect(account).toBeInViewport();
    const menu = page.getByRole("button", { name: "Menu", exact: true });
    await expect(menu).toBeInViewport();
    await menu.click();
    const sheet = page.getByRole("dialog", { name: "Modules" });
    await expect(sheet).toBeVisible();
    await expectTouchTargets(page, "the navigation menu");
    await expectAccessible(page, "the navigation menu");
    // The section name follows the organisation's terminology ("Residents", "People"); its
    // address does not.
    await sheet.locator('a[href="/people"]').click();
    await page.waitForURL((url) => url.pathname === "/people");
    await expect(sheet).toBeHidden();
    await expectNoHorizontalOverflow(page, "people from the menu");
    // Escape closes the menu and returns focus to its button.
    await menu.click();
    await page.keyboard.press("Escape");
    await expect(menu).toBeFocused();
    await account.click();
    const signOut = page.getByRole("menuitem", { name: "Sign out" });
    await expect(signOut).toBeInViewport();
    await expectTouchTargets(page, "the account menu");
    await signOut.click();
    await page.waitForURL((url) => url.pathname === "/sign-in");
  });

  for (const [path, name] of MANAGER_SCREENS) {
    test(`manager: ${name} fits`, async ({ page }) => {
      await signIn(page, "manager@example.invalid");
      await checkScreen(page, path, name);
    });
  }

  for (const [path, name] of OWNER_SCREENS) {
    test(`owner: ${name} fits`, async ({ page }) => {
      await signIn(page, "owner@example.invalid");
      await checkScreen(page, path, name);
    });
  }

  // Type sizes are in rem, so a browser's text size setting resizes them (WCAG 1.4.4).
  for (const [path, name] of [
    [`/people/${demoPerson(1)}`, "person overview"],
    ["/tasks", "tasks"],
    ["/incidents/new", "new incident"],
  ] as const) {
    test(`text at 200% still reflows: ${name}`, async ({ page }) => {
      await signIn(page, "manager@example.invalid");
      await page.goto(path);
      await page.addStyleTag({ content: "html { font-size: 200% !important; }" });
      const body = await page.evaluate(() => getComputedStyle(document.body).fontSize);
      // 17 px body text at the default; 34 px at 200%.
      expect(body).toBe("34px");
      await expectNoHorizontalOverflow(page, `${name} at 200% text`);
    });
  }
});
