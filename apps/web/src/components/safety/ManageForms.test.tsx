// @vitest-environment jsdom
import axe from "axe-core";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StepUpNotice } from "./ManageForms";

/**
 * The step-up state of the notification forms (section 5.3; HZ-013), which the journey cannot
 * reach (its sign-in is always fresh): an alert with an icon and words, and the way back to this
 * page after signing in again, checked with axe-core. Contrast is left to the real browser.
 */
describe("StepUpNotice", () => {
  it("says to sign in again and links back to the page, accessibly", async () => {
    document.body.innerHTML = `<main><h1>Notification</h1>${renderToStaticMarkup(
      <StepUpNotice next="/notifications/statutory/0194d000-0000-7000-8000-00000000b001" />,
    )}</main>`;
    const alert = document.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("Confirm it is you");
    expect(alert?.textContent).toContain("What you typed here is not kept");
    const link = alert?.querySelector("a");
    expect(link?.textContent).toBe("Sign in again");
    const href = new URL(link?.getAttribute("href") ?? "", "https://harbour.example.invalid");
    expect(href.pathname).toBe("/sign-in");
    expect(href.searchParams.get("reason")).toBe("step-up");
    expect(href.searchParams.get("next")).toBe(
      "/notifications/statutory/0194d000-0000-7000-8000-00000000b001",
    );
    const results = await axe.run(document.body, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] },
      rules: { "color-contrast": { enabled: false } },
    });
    expect(results.violations.map((v) => v.id)).toEqual([]);
  });
});
