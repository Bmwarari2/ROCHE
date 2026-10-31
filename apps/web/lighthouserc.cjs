/**
 * Lighthouse CI for the web tier (master prompt section 7, performance gate). Budgets from
 * docs/01-CONSTRAINTS.md: web first paint under 1.5 s. Desktop preset (staff use the web app on
 * desktops and laptops; the phone is the mobile app's job), median of three runs per page.
 *
 * Run by scripts/lighthouse.mjs, which collects twice against a production build (`next start`)
 * with the API and the seeded demo database: once signed out, then signed in as the demo manager
 * with the session cookie in HARBOUR_LHCI_COOKIE. Demo data only: invented people.
 */

const WEB_URL = process.env.WEB_URL ?? "http://localhost:3000";
/** Ada Example, the first demo resident (packages/db/src/seed/demo.ts). */
const DEMO_PERSON = "0194d000-0000-7000-8600-000000000001";

const SIGNED_OUT = ["/sign-in", "/invitation"];
const SIGNED_IN = ["/", "/people", `/people/${DEMO_PERSON}`, "/incidents"];

const cookie = process.env.HARBOUR_LHCI_COOKIE;
const median = { aggregationMethod: "median-run" };

module.exports = {
  ci: {
    collect: {
      url: (cookie ? SIGNED_IN : SIGNED_OUT).map((path) => `${WEB_URL}${path}`),
      numberOfRuns: 3,
      settings: {
        preset: "desktop",
        chromeFlags: "--headless=new --no-sandbox",
        // Only the session cookie: Lighthouse sends these headers with every request it makes.
        ...(cookie ? { extraHeaders: JSON.stringify({ Cookie: cookie }) } : {}),
      },
    },
    assert: {
      assertions: {
        // The budget: first paint under 1.5 s.
        "first-contentful-paint": ["error", { ...median, maxNumericValue: 1500 }],
        "cumulative-layout-shift": ["error", { ...median, maxNumericValue: 0.1 }],
        "largest-contentful-paint": ["warn", { ...median, maxNumericValue: 2500 }],
        "total-blocking-time": ["warn", { ...median, maxNumericValue: 200 }],
        "categories:performance": ["warn", { ...median, minScore: 0.9 }],
        // axe in the Playwright journeys is the accessibility gate; this catches regressions in
        // what Lighthouse checks on top (for example the document title and language).
        "categories:accessibility": ["error", { ...median, minScore: 0.95 }],
      },
    },
    upload: {
      target: "filesystem",
      outputDir: ".lighthouseci/reports",
    },
  },
};
