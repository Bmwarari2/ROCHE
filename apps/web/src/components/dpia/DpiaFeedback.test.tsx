// @vitest-environment jsdom
import axe from "axe-core";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ManageFeedback } from "@/components/safety/ManageForms";
import { t } from "@/lib/i18n";

/**
 * The DPIA page's step-up refusals the journey cannot reach (its passkey sign-in is always
 * fresh): naming a different lead and signing each ask for a passkey or authenticator code with
 * the way back to the page, checked with axe-core.
 */
async function violations() {
  const results = await axe.run(document.body, {
    runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] },
    rules: { "color-contrast": { enabled: false } },
  });
  return results.violations.map((v) => v.id);
}

describe("the DPIA page's step-up notices", () => {
  it.each([
    ["naming a different lead", "dpia.settings.stepUp", "Changing who signs the DPIA"],
    ["signing", "dpia.sign.stepUp", "Signing the DPIA"],
  ] as const)("asks to step up for %s, with the way back", async (_, key, words) => {
    document.body.innerHTML = `<main><h1>Data protection</h1>${renderToStaticMarkup(
      <ManageFeedback
        result={{ ok: false, code: "step_up_required", message: "" }}
        path="/settings/data-protection"
        stepUp={t(key)}
      />,
    )}</main>`;
    const alert = document.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain(words);
    const href = new URL(
      alert?.querySelector("a")?.getAttribute("href") ?? "",
      "https://harbour.example.invalid",
    );
    expect(href.searchParams.get("reason")).toBe("step-up");
    expect(href.searchParams.get("next")).toBe("/settings/data-protection");
    expect(await violations()).toEqual([]);
  });
});
