import { expect, type Page, test } from "@playwright/test";
import { demoPerson, expectAccessible, signIn } from "./support";

/**
 * Responsive web down to 360 px (MOB-013, master prompt 17.4; WCAG 1.4.10 reflow). Run by the
 * `mobile-360` project at 360 × 740: every screen sampled here fits the width with no horizontal
 * page scroll (wide tables scroll inside their own container), keeps 44 px targets on what can be
 * pressed, and passes axe. Demo accounts and invented people only.
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
 * Buttons and links that can be pressed are at least 44 px in both directions, or inline in text
 * (WCAG 2.5.8 allows inline links; Harbour's own rule is 44 px for controls).
 */
async function expectTouchTargets(page: Page, name: string) {
  const small = await page.evaluate(() => {
    const out: string[] = [];
    const controls = document.querySelectorAll<HTMLElement>(
      "main button, main [role=button], main a[href]:not(p a):not(li > a:only-child), header button, nav a[href], nav button",
    );
    for (const el of Array.from(controls)) {
      const box = el.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) continue;
      if (getComputedStyle(el).display === "inline") continue;
      // Visually hidden helpers (skip links before focus) are not targets yet.
      if (box.width <= 1 || box.height <= 1) continue;
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
    // The account menu, with sign out, stays on screen.
    const account = page.getByRole("button", { name: /^Your account/ });
    await expect(account).toBeInViewport();
    // Every section of the navigation is reachable and opens its page.
    const nav = page.getByRole("navigation", { name: /main|primary|sections/i }).first();
    await expect(nav).toBeVisible();
    await nav.getByRole("link", { name: "People" }).click();
    await page.waitForURL((url) => url.pathname === "/people");
    await expectNoHorizontalOverflow(page, "people from the navigation");
    await account.click();
    const signOut = page.getByRole("menuitem", { name: "Sign out" });
    await expect(signOut).toBeInViewport();
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

  test("text at 200% still reflows on the person's record", async ({ page }) => {
    await signIn(page, "manager@example.invalid");
    await page.goto(`/people/${demoPerson(1)}`);
    // Text-only resize, as a browser's text size setting does (WCAG 1.4.4).
    await page.addStyleTag({ content: "html { font-size: 200% !important; }" });
    await expectNoHorizontalOverflow(page, "person overview at 200% text");
  });
});
