// @vitest-environment jsdom
import axe from "axe-core";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ManageFeedback } from "@/components/safety/ManageForms";
import { t } from "@/lib/i18n";
import { problemMessage } from "@/lib/outcome";

/**
 * The export page's refusals the journey cannot reach (its step-up is always fresh, and a cancel
 * the API refuses needs a race): the step-up notice in passkey and authenticator words with the
 * way back, and a refused cancel said in words, each checked with axe-core.
 */
async function violations() {
  const results = await axe.run(document.body, {
    runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] },
    rules: { "color-contrast": { enabled: false } },
  });
  return results.violations.map((v) => v.id);
}

const render = (result: Parameters<typeof ManageFeedback>[0]["result"]) => {
  document.body.innerHTML = `<main><h1>Data export</h1>${renderToStaticMarkup(
    <ManageFeedback result={result} path="/settings/export" stepUp={t("export.stepUp")} />,
  )}</main>`;
  return document.querySelector('[role="alert"]');
};

describe("the export page's refusals", () => {
  it("hazard HZ-070 asks for a passkey or authenticator code to step up, with the way back", async () => {
    const alert = render({ ok: false, code: "step_up_required", message: "" });
    expect(alert?.textContent).toContain("passkey or a code from your authenticator app");
    const href = new URL(
      alert?.querySelector("a")?.getAttribute("href") ?? "",
      "https://harbour.example.invalid",
    );
    expect(href.searchParams.get("reason")).toBe("step-up");
    expect(href.searchParams.get("next")).toBe("/settings/export");
    expect(await violations()).toEqual([]);
  });

  it("says a refused cancel in words", async () => {
    const alert = render({
      ok: false,
      ...problemMessage({ code: "not_found", detail: "" }, t),
    });
    expect(alert?.textContent).toContain(t("errors.notFound"));
    expect(await violations()).toEqual([]);
  });
});
