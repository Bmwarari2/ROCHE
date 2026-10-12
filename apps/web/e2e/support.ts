import AxeBuilder from "@axe-core/playwright";
import { expect, type Page } from "@playwright/test";

/**
 * Shared steps for the care record journeys. Demo accounts only: invented people, example.invalid
 * emails, NHS numbers in the 999 range (master prompt section 20).
 */

export const PASSWORD = process.env.HARBOUR_DEMO_PASSWORD ?? "correct horse battery staple";
export const WCAG_AA = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

/**
 * A resident of Harbour Mews, a second home nobody at Harbour House can see (apps/api/scripts/
 * seed-users.ts): opened by break-glass in the journeys.
 */
export const MEWS_PERSON = "0194d000-0000-7000-8600-000000000150";

/** The demo residents' ids from packages/db/src/seed/demo.ts. */
export function demoPerson(n: number): string {
  return `0194d000-0000-7000-8600-${n.toString(16).padStart(12, "0")}`;
}

/**
 * Waits for entry animations (a sheet or menu fading in) to finish, so axe measures contrast on
 * what people see once it has settled, not a half-transparent frame. Endless animations, such as
 * a spinner, are skipped.
 */
export async function settleAnimations(page: Page) {
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
        .map((animation) => animation.finished.catch(() => undefined)),
    ),
  );
}

/** WCAG 2.2 AA with axe: no serious or critical violations. */
export async function expectAccessible(page: Page, name: string) {
  await settleAnimations(page);
  const results = await new AxeBuilder({ page }).withTags(WCAG_AA).analyze();
  const blocking = results.violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map((v) => ({
      id: v.id,
      impact: v.impact,
      help: v.help,
      targets: v.nodes.map((n) => n.target.join(" ")),
    }));
  expect(blocking, `${name}: serious or critical accessibility violations`).toEqual([]);
}

export async function signIn(page: Page, email: string) {
  await page.goto("/sign-in");
  await page.getByLabel("Email address").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL((url) => url.pathname === "/");
}
