// @vitest-environment jsdom
import axe from "axe-core";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DpiaStatus, type DpiaStatusView } from "./DpiaStatus";

/**
 * The DPIA's states the journey cannot reach on a seeded database (not started with details
 * missing, and due for review with its reasons), each said in words and checked with axe-core.
 */
async function violations() {
  const results = await axe.run(document.body, {
    runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] },
    rules: { "color-contrast": { enabled: false } },
  });
  return results.violations.map((v) => v.id);
}

const render = (dpia: DpiaStatusView) => {
  document.body.innerHTML = `<main><h1>Data protection</h1>${renderToStaticMarkup(
    <DpiaStatus dpia={dpia} />,
  )}</main>`;
  return document.body.textContent ?? "";
};

const NONE = { signed: null, reviewDueAt: null, triggers: [], missingConfig: [] };

describe("where the DPIA stands", () => {
  it("says it is not started, and lists the details Harbour still needs", async () => {
    const text = render({
      ...NONE,
      state: "not_started",
      missingConfig: ["tenant.dpo", "tenant.privacyNoticeUrl"],
    });
    expect(text).toContain("Not started");
    expect(text).toContain("Your data protection officer's name and email address");
    expect(text).toContain("A link to your privacy notice");
    expect(await violations()).toEqual([]);
  });

  it("says a review is due, and why", async () => {
    const text = render({
      ...NONE,
      state: "review_due",
      signed: { signedAt: "2025-09-01T10:00:00Z", signedBy: { displayName: "Olive Owner" } },
      reviewDueAt: "2026-09-01T10:00:00Z",
      triggers: [{ kind: "yearly_review" }, { kind: "new_sub_processor" }],
    });
    expect(text).toContain("Review due");
    expect(text).toContain("Signed by Olive Owner on 01/09/2025 11:00.");
    expect(text).toContain("A year has passed since it was signed.");
    expect(text).toContain("A new sub-processor handles your data since it was signed.");
    expect(await violations()).toEqual([]);
  });
});
