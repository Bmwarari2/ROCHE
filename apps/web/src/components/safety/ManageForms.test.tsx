// @vitest-environment jsdom
import axe from "axe-core";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { t } from "@/lib/i18n";
import { ManageFeedback, StepUpNotice } from "./ManageForms";

/**
 * The step-up state of the notification forms (section 5.3; HZ-013), which the journey cannot
 * reach (its sign-in is always fresh): an alert with an icon and words, and the way back to this
 * page after signing in again, checked with axe-core. Contrast is left to the real browser.
 */
describe("StepUpNotice", () => {
  it("hazard HZ-091 says to sign in again and links back to the page, accessibly", async () => {
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

describe("ManageFeedback", () => {
  const path = "/incidents/0194d000-0000-7000-8000-00000000b002";

  it("hazard HZ-091 says the separation of duties refusal in words a manager can act on, accessibly", async () => {
    // The journey cannot reach it: close is never offered to the person who raised the incident.
    const result = {
      ok: false as const,
      code: "separation_of_duties",
      message: t("errors.separationOfDuties"),
    };
    document.body.innerHTML = `<main><h1>Incident</h1>${renderToStaticMarkup(
      <ManageFeedback result={result} path={path} />,
    )}</main>`;
    const alert = document.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("There is a problem");
    expect(alert?.textContent).toContain(
      "Someone other than the person who raised this incident must close it.",
    );
    expect(await violations()).toEqual([]);
  });

  it("hazard HZ-091 shows the step-up notice for a step-up refusal, and nothing on success", () => {
    const stepUp = renderToStaticMarkup(
      <ManageFeedback result={{ ok: false, code: "step_up_required", message: "" }} path={path} />,
    );
    expect(stepUp).toContain("Sign in again");
    expect(stepUp).toContain("confirm with your passkey or authenticator code");
    expect(
      renderToStaticMarkup(<ManageFeedback result={{ ok: true, data: null }} path={path} />),
    ).toBe("");
  });
});

async function violations() {
  const results = await axe.run(document.body, {
    runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] },
    rules: { "color-contrast": { enabled: false } },
  });
  return results.violations.map((v) => v.id);
}
